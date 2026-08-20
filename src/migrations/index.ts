import * as migration_20260702_231336_initial_schema from './20260702_231336_initial_schema';
import * as migration_20260714_014601_add_wtb_schema from './20260714_014601_add_wtb_schema';
import * as migration_20260801_082303_migration_hardening from './20260801_082303_migration_hardening';
import * as migration_20260805_023748_add_pinned_until from './20260805_023748_add_pinned_until';
import * as migration_20260820_084629_add_content_type from './20260820_084629_add_content_type';

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
    name: '20260801_082303_migration_hardening',
  },
  {
    up: migration_20260805_023748_add_pinned_until.up,
    down: migration_20260805_023748_add_pinned_until.down,
    name: '20260805_023748_add_pinned_until'
  },
  {
    up: migration_20260820_084629_add_content_type.up,
    down: migration_20260820_084629_add_content_type.down,
    name: '20260820_084629_add_content_type'
  },
];
