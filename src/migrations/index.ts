import * as migration_20260702_231336_initial_schema from './20260702_231336_initial_schema';
import * as migration_20260714_014601_add_wtb_schema from './20260714_014601_add_wtb_schema';
import * as migration_20260801_082303_migration_hardening from './20260801_082303_migration_hardening';

export const migrations = [
  {
    up: migration_20260702_231336_initial_schema.up,
    down: migration_20260702_231336_initial_schema.down,
    name: '20260702_231336_initial_schema',
  },
  {
    up: migration_20260714_014601_add_wtb_schema.up,
    down: migration_20260714_014601_add_wtb_schema.down,
    name: '20260714_014601_add_wtb_schema',
  },
  {
    up: migration_20260801_082303_migration_hardening.up,
    down: migration_20260801_082303_migration_hardening.down,
    name: '20260801_082303_migration_hardening'
  },
];
