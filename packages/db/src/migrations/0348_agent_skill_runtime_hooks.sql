CREATE OR REPLACE FUNCTION paperclip_invalidate_company_agent_runtimes(p_company uuid) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE candidate uuid;
BEGIN
  FOR candidate IN SELECT id FROM agents WHERE company_id = p_company
    AND status NOT IN ('pending_approval', 'terminated') ORDER BY id FOR UPDATE LOOP
    PERFORM paperclip_record_agent_runtime(p_company, candidate);
  END LOOP;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_company_agent_runtimes_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE column_name text; changed boolean := false;
BEGIN
  IF TG_OP = 'UPDATE' AND TG_NARGS > 0 THEN
    FOREACH column_name IN ARRAY TG_ARGV LOOP
      IF to_jsonb(OLD)->column_name IS DISTINCT FROM to_jsonb(NEW)->column_name THEN changed := true; END IF;
    END LOOP;
    IF NOT changed THEN RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND (to_jsonb(OLD) - ARRAY['updated_at', 'created_at']) IS NOT DISTINCT FROM
    (to_jsonb(NEW) - ARRAY['updated_at', 'created_at']) THEN RETURN NEW; END IF;
  IF TG_OP <> 'INSERT' THEN PERFORM paperclip_invalidate_company_agent_runtimes(OLD.company_id); END IF;
  IF TG_OP = 'INSERT' OR (TG_OP = 'UPDATE' AND NEW.company_id IS DISTINCT FROM OLD.company_id) THEN
    PERFORM paperclip_invalidate_company_agent_runtimes(NEW.company_id);
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_skill_runtime_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE previous jsonb; current jsonb; keys text[]; company uuid; candidate uuid;
BEGIN
  IF TG_OP <> 'INSERT' THEN previous := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN current := to_jsonb(NEW); END IF;
  IF TG_OP = 'UPDATE' AND
    jsonb_build_array(OLD.key, OLD.slug, OLD.markdown, OLD.source_type, OLD.source_locator, OLD.source_ref,
      OLD.file_inventory, OLD.current_version_id, OLD.access_source_id, OLD.compatibility, OLD.trust_level, OLD.metadata)
    IS NOT DISTINCT FROM
    jsonb_build_array(NEW.key, NEW.slug, NEW.markdown, NEW.source_type, NEW.source_locator, NEW.source_ref,
      NEW.file_inventory, NEW.current_version_id, NEW.access_source_id, NEW.compatibility, NEW.trust_level, NEW.metadata)
    THEN RETURN NEW; END IF;
  company := coalesce((current->>'company_id')::uuid, (previous->>'company_id')::uuid);
  SELECT array_agg(DISTINCT lower(reference)) INTO keys FROM (
    SELECT row->>'key' AS reference FROM unnest(ARRAY[previous, current]) row
    UNION ALL SELECT regexp_replace(row->>'key', '.*/', '') FROM unnest(ARRAY[previous, current]) row
    UNION ALL SELECT CASE WHEN row->>'key' LIKE 'paperclipai/paperclip/%' THEN row->>'slug'
      ELSE (row->>'slug') || '--' || left(encode(sha256(convert_to(row->>'key', 'UTF8')), 'hex'), 10) END
      FROM unnest(ARRAY[previous, current]) row
  ) refs WHERE reference IS NOT NULL;
  FOR candidate IN SELECT a.id FROM agents a WHERE a.company_id = company
    AND a.status NOT IN ('pending_approval', 'terminated') AND (
      (a.adapter_type <> 'paperclip_runner' AND 'paperclipai/paperclip/paperclip' = ANY(keys)) OR
      EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(a.adapter_config#>'{paperclipSkillSync,desiredSkills}') = 'array'
        THEN a.adapter_config#>'{paperclipSkillSync,desiredSkills}' ELSE '[]'::jsonb END) choice
        WHERE lower(trim(CASE WHEN jsonb_typeof(choice) = 'string' THEN choice#>>'{}' ELSE choice->>'key' END)) = ANY(keys)))
    ORDER BY a.id FOR UPDATE LOOP
    PERFORM paperclip_record_agent_runtime(company, candidate);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_skill_runtime_changed ON company_skills;
CREATE TRIGGER paperclip_skill_runtime_changed AFTER INSERT OR UPDATE OR DELETE ON company_skills
  FOR EACH ROW EXECUTE FUNCTION paperclip_skill_runtime_changed();
--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_skill_policy_runtime_changed ON company_skill_policies;
CREATE TRIGGER paperclip_skill_policy_runtime_changed AFTER INSERT OR UPDATE OR DELETE ON company_skill_policies
  FOR EACH ROW EXECUTE FUNCTION paperclip_company_agent_runtimes_changed();
--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_skill_source_runtime_changed ON project_skill_sources;
CREATE TRIGGER paperclip_skill_source_runtime_changed AFTER INSERT OR UPDATE OR DELETE ON project_skill_sources
  FOR EACH ROW EXECUTE FUNCTION paperclip_company_agent_runtimes_changed('project_id', 'source_id', 'active');

--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_skill_source_access_runtime_changed ON company_skill_sources;
CREATE TRIGGER paperclip_skill_source_access_runtime_changed AFTER INSERT OR UPDATE OR DELETE ON company_skill_sources
  FOR EACH ROW EXECUTE FUNCTION paperclip_company_agent_runtimes_changed('access_scope', 'removed_at');
--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_project_access_runtime_changed ON project_access_members;
CREATE TRIGGER paperclip_project_access_runtime_changed AFTER INSERT OR UPDATE OR DELETE ON project_access_members
  FOR EACH ROW EXECUTE FUNCTION paperclip_company_agent_runtimes_changed();
--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_project_privacy_runtime_changed ON projects;
CREATE TRIGGER paperclip_project_privacy_runtime_changed AFTER UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION paperclip_company_agent_runtimes_changed('visibility', 'privacy_owner_user_id', 'personal_owner_user_id');
--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_skill_pins_runtime_changed() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE company uuid;
BEGIN
  IF coalesce(OLD.experimental->'enableBetaSkills', 'false'::jsonb) IS DISTINCT FROM coalesce(NEW.experimental->'enableBetaSkills', 'false'::jsonb) THEN
    FOR company IN SELECT DISTINCT company_id FROM agents ORDER BY company_id LOOP
      PERFORM paperclip_invalidate_company_agent_runtimes(company);
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS paperclip_skill_pins_runtime_changed ON instance_settings;
CREATE TRIGGER paperclip_skill_pins_runtime_changed AFTER UPDATE ON instance_settings
  FOR EACH ROW EXECUTE FUNCTION paperclip_skill_pins_runtime_changed();
