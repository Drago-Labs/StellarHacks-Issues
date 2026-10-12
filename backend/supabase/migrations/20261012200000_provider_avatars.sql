-- A face for everybody who signed in with one.
--
-- The provider's picture used to be offered only to its owner, on the settings
-- page, as a suggestion. Every other surface reads `profiles.avatar_url`, so an
-- organizer reviewing applications saw an initial where the applicant had a
-- photograph, and the only way to fix it was for each applicant to upload the
-- picture Google had already handed over.
--
-- So the picture is written at sign up, and once now for the accounts that
-- already exist. Only where the profile has none: somebody who uploaded their
-- own keeps it, and anybody can still replace or remove what was filled in.

create or replace function public.claim_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, username, avatar_url)
  values (
    new.id,
    'user_' || substr(replace(new.id::text, '-', ''), 1, 12),
    -- Google sends the same picture under both names; other providers send one.
    nullif(
      trim(coalesce(new.raw_user_meta_data ->> 'avatar_url', new.raw_user_meta_data ->> 'picture')),
      ''
    )
  );

  return new;
end;
$$;

update public.profiles p
set avatar_url = nullif(
  trim(coalesce(u.raw_user_meta_data ->> 'avatar_url', u.raw_user_meta_data ->> 'picture')),
  ''
)
from auth.users u
where u.id = p.id
  and p.avatar_url is null;
