-- Apply after the new frontend and drive-api are live and verified.
-- Keep the function for rollback, but prohibit direct browser credential checks.
revoke all on function public.validar_acceso_drive(text,text) from public, anon, authenticated;
