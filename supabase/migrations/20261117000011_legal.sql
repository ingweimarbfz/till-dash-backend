-- =====================================================================
-- TD-004 · Documentos legales y firma (como en Integra IPS)
-- · provider_info: datos de TillDash+ como proveedor (van en el contrato y en el acuerdo de datos).
-- · legal_signatures: firmas del contrato y del acuerdo de datos por establecimiento, versión y parte
--   (cliente / proveedor), con el texto firmado, la firma, la IP y el navegador como evidencia.
-- · terms_acceptances: aceptación de los términos y condiciones por usuario y versión.
-- =====================================================================

create table if not exists public.provider_info (
  id int primary key default 1 check (id = 1),
  legal_name text not null default 'TillDash+',
  nit text,
  legal_rep text,
  legal_rep_id text,
  city text default 'Barranquilla',
  address text,
  email text,
  phone text,
  support_hours text default 'Lunes a sábado de 8:00 a. m. a 8:00 p. m.',
  privacy_email text,
  hosting text default 'Supabase (base de datos, Estados Unidos), Render (servidor de la aplicación, Estados Unidos) y Vercel (sitio web, red global)',
  updated_at timestamptz not null default now()
);
insert into public.provider_info (id) values (1) on conflict (id) do nothing;

create table if not exists public.legal_signatures (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  kind text not null check (kind in ('contrato', 'datos')),
  version text not null,
  party text not null check (party in ('cliente', 'proveedor')),
  user_id bigint references public.users(id) on delete set null,
  signer_name text not null,
  signer_id text,
  signer_role text,
  signature_url text not null,
  snapshot jsonb not null,
  ip text,
  user_agent text,
  signed_at timestamptz not null default now(),
  constraint legal_signatures_once unique (org_id, kind, version, party)
);

create table if not exists public.terms_acceptances (
  id bigint generated always as identity primary key,
  org_id bigint not null references public.organizations(id) on delete cascade,
  user_id bigint not null references public.users(id) on delete cascade,
  version text not null,
  ip text,
  user_agent text,
  accepted_at timestamptz not null default now(),
  constraint terms_acceptances_once unique (user_id, version)
);

alter table public.provider_info enable row level security;
alter table public.legal_signatures enable row level security;
alter table public.terms_acceptances enable row level security;
