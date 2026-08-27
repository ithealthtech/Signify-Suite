ALTER TABLE application_integrations
  DROP CONSTRAINT application_integrations_provider_check;

ALTER TABLE application_integrations
  ADD CONSTRAINT application_integrations_provider_check
  CHECK (provider IN ('microsoft','stripe','github','email'));
