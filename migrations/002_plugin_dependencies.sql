-- migrations/002_plugin_dependencies.sql
ALTER TABLE packages ADD COLUMN dependencies TEXT NOT NULL DEFAULT '[]';
