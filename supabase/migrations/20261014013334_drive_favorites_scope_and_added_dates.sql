create or replace function public.drive_login_v2(p_identity text,p_code text,p_ip_hash text,p_token_hash text)
returns jsonb language plpgsql security invoker set search_path='' as $fn$
declare
  v_id bigint; v_name text; v_identity text; v_key text; v_row public.drive_attempts_v2;
  v_limit integer; v_retry integer:=0; v_now timestamptz:=clock_timestamp(); v_expires timestamptz;
begin
  if coalesce(p_token_hash,'') !~ '^[a-f0-9]{64}$' or coalesce(p_ip_hash,'') !~ '^[a-f0-9]{64}$' then
    return jsonb_build_object('ok',false,'status',400);
  end if;
  v_identity:=regexp_replace(coalesce(p_identity,''),'\D','','g');
  if length(v_identity)<6 or length(v_identity)>12 or length(btrim(coalesce(p_code,'')))<4 or length(p_code)>80 then
    return jsonb_build_object('ok',false,'status',400);
  end if;
  -- Lock buckets in a deterministic order to avoid races and deadlocks.
  for v_key in select x from unnest(array['identity:'||md5(v_identity),'ip:'||p_ip_hash]) x order by x loop
    insert into public.drive_attempts_v2(bucket,window_start) values(v_key,v_now) on conflict do nothing;
    select * into v_row from public.drive_attempts_v2 where bucket=v_key for update;
    if v_row.window_start<=v_now-interval '10 minutes' then
      update public.drive_attempts_v2 set attempts=0,window_start=v_now where bucket=v_key;
      v_row.attempts:=0; v_row.window_start:=v_now;
    end if;
    v_limit:=case when v_key like 'ip:%' then 50 else 5 end;
    if v_row.attempts>=v_limit then
      v_retry:=greatest(v_retry,ceil(extract(epoch from v_row.window_start+interval '10 minutes'-v_now))::integer);
    end if;
  end loop;
  if v_retry>0 then return jsonb_build_object('ok',false,'status',429,'retryAfter',v_retry); end if;
  update public.drive_attempts_v2 set attempts=attempts+1 where bucket in ('identity:'||md5(v_identity),'ip:'||p_ip_hash);
  select i.id,concat_ws(' ',nullif(btrim(i.nombres),''),nullif(btrim(i.apellidos),'')) into v_id,v_name
    from public.integrantes i
    where regexp_replace(coalesce(i.cedula,''),'\D','','g')=v_identity
      and upper(btrim(coalesce(i.codigo_integrante,'')))=upper(btrim(p_code))
      and not exists(select 1 from public.drive_access_blocks_v2 b where b.integrante_id=i.id and (b.blocked_until is null or b.blocked_until>v_now))
    limit 1;
  if v_id is null then return jsonb_build_object('ok',false,'status',401); end if;
  update public.drive_attempts_v2 set attempts=0 where bucket='identity:'||md5(v_identity);
  v_expires:=v_now+interval '2 hours';
  insert into public.drive_sessions_v2(token_hash,integrante_id,created_at,expires_at) values(p_token_hash,v_id,v_now,v_expires);
  delete from public.drive_sessions_v2 where expires_at<v_now-interval '1 day';
  delete from public.drive_attempts_v2 where window_start<v_now-interval '1 day';
  return jsonb_build_object('ok',true,'name',coalesce(nullif(v_name,''),'Integrante'),'expiresAt',floor(extract(epoch from v_expires)*1000),'favoritesScope',md5('drive-favorites:'||v_id::text));
end $fn$;
create or replace function public.drive_session_v2(p_token_hash text,p_action text default 'validate')
returns jsonb language plpgsql security invoker set search_path='' as $fn$
declare v_session public.drive_sessions_v2; v_name text; v_now timestamptz:=clock_timestamp();
begin
  select * into v_session from public.drive_sessions_v2 where token_hash=p_token_hash for update;
  if not found or v_session.revoked_at is not null or v_session.expires_at<=v_now or
    exists(select 1 from public.drive_access_blocks_v2 b where b.integrante_id=v_session.integrante_id and (b.blocked_until is null or b.blocked_until>v_now)) then
    return jsonb_build_object('ok',false,'status',401);
  end if;
  if p_action='logout' then
    update public.drive_sessions_v2 set revoked_at=v_now where token_hash=p_token_hash;
    return jsonb_build_object('ok',true);
  elsif p_action='renew' then
    v_session.expires_at:=least(v_now+interval '2 hours',v_session.created_at+interval '8 hours');
    update public.drive_sessions_v2 set expires_at=v_session.expires_at where token_hash=p_token_hash;
  elsif p_action<>'validate' then return jsonb_build_object('ok',false,'status',400);
  end if;
  select concat_ws(' ',nullif(btrim(nombres),''),nullif(btrim(apellidos),'')) into v_name from public.integrantes where id=v_session.integrante_id;
  return jsonb_build_object('ok',true,'name',coalesce(nullif(v_name,''),'Integrante'),'expiresAt',floor(extract(epoch from v_session.expires_at)*1000),'favoritesScope',md5('drive-favorites:'||v_session.integrante_id::text));
end $fn$;
create or replace function public.drive_catalog_api_v2(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $fn$
declare v_row public.drive_catalog_v2; v_config public.drive_config_v2; v_catalog jsonb; v_now timestamptz:=clock_timestamp();
begin
  if p_action='config' then
    select * into v_config from public.drive_config_v2 where id;
    return jsonb_build_object('root',v_config.root_folder,'key',v_config.google_api_key);
  elsif p_action='read' then
    select * into v_row from public.drive_catalog_v2 where id;
    return jsonb_build_object('catalog',v_row.payload,'updatedAt',v_row.updated_at,'refreshing',coalesce(v_row.refreshing_until>v_now,false),'lastError',v_row.last_error);
  elsif p_action='claim' then
    update public.drive_catalog_v2 set refresh_owner=p_payload->>'owner',refreshing_until=v_now+interval '90 seconds',last_attempt_at=v_now
      where id and (refreshing_until is null or refreshing_until<v_now) and (last_attempt_at is null or last_attempt_at<v_now-interval '5 minutes')
      returning * into v_row;
    return jsonb_build_object('claimed',found);
  elsif p_action='commit' then
    if jsonb_typeof(p_payload->'catalog'->'items')<>'array' or jsonb_typeof(p_payload->'catalog'->'folders')<>'array' then raise exception 'invalid catalog'; end if;
    select * into v_row from public.drive_catalog_v2 where id for update;
    if v_row.refresh_owner is distinct from (p_payload->>'owner') or v_row.refreshing_until<=v_now then return jsonb_build_object('ok',false); end if;
    select jsonb_set(p_payload->'catalog','{items}',coalesce(jsonb_agg(n.item || jsonb_build_object('addedAt',case when o.item is not null then o.item->'addedAt' when v_row.payload->>'trackingEnabledAt' is null then null else to_jsonb(v_now) end) order by n.position),'[]'::jsonb))
      into v_catalog
      from jsonb_array_elements(p_payload->'catalog'->'items') with ordinality n(item,position)
      left join jsonb_array_elements(v_row.payload->'items') o(item) on o.item->>'id'=n.item->>'id';
    v_catalog:=v_catalog || jsonb_build_object('trackingEnabledAt',coalesce(v_row.payload->'trackingEnabledAt',to_jsonb(v_now)));
    update public.drive_catalog_v2 set payload=v_catalog,updated_at=v_now,refresh_owner=null,refreshing_until=null,last_error=null
      where id and refresh_owner=p_payload->>'owner' and refreshing_until>v_now;
    return jsonb_build_object('ok',found);
  elsif p_action='fail' then
    update public.drive_catalog_v2 set refreshing_until=null,refresh_owner=null,last_error='No fue posible actualizar el catálogo. Se conserva la última versión completa.' where id and refresh_owner=p_payload->>'owner';
    return jsonb_build_object('ok',true);
  end if;
  return jsonb_build_object('ok',false,'status',400);
end $fn$;