import * as migration_20260702_231336_initial_schema from './20260702_231336_initial_schema';
import * as migration_20260714_014601_add_wtb_schema from './20260714_014601_add_wtb_schema';
import * as migration_20260801_082303_migration_hardening from './20260801_082303_migration_hardening';
import * as migration_20260805_023748_add_pinned_until from './20260805_023748_add_pinned_until';
import * as migration_20260820_084629_add_content_type from './20260820_084629_add_content_type';
import * as migration_20260824_000000_add_exclusive_flag from './20260824_000000_add_exclusive_flag';
import * as migration_20260904_000000_dtw_dashboards_port from './20260904_000000_dtw_dashboards_port';
import * as migration_20260910_000000_add_video_support from './20260910_000000_add_video_support';
import * as migration_20260910_010000_add_video_media_credit_fields from './20260910_010000_add_video_media_credit_fields';

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
  {
    up: migration_20260824_000000_add_exclusive_flag.up,
    down: migration_20260824_000000_add_exclusive_flag.down,
    name: '20260824_000000_add_exclusive_flag'
  },
  {
    up: migration_20260904_000000_dtw_dashboards_port.up,
    down: migration_20260904_000000_dtw_dashboards_port.down,
    name: '20260904_000000_dtw_dashboards_port'
  },
  {
    up: migration_20260910_000000_add_video_support.up,
    down: migration_20260910_000000_add_video_support.down,
    name: '20260910_000000_add_video_support'
  },
  {
    up: migration_20260910_010000_add_video_media_credit_fields.up,
    down: migration_20260910_010000_add_video_media_credit_fields.down,
    name: '20260910_010000_add_video_media_credit_fields'
  },
];
