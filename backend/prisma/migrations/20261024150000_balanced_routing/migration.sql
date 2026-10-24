-- Default upload routing: fill accounts evenly by % used.
ALTER TABLE `upload_routing_policies` ALTER COLUMN `mode` SET DEFAULT 'balanced';
UPDATE `upload_routing_policies` SET `mode` = 'balanced' WHERE `mode` = 'most_available';
