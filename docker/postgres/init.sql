-- Local and CI only. Creates the two database users the system design asks
-- for (SDD 16.6): erp_migrator owns the schema; erp_app reads and writes data
-- and is subject to row-level security. Passwords here are local defaults.
create role erp_migrator login password 'erp_migrator';
create role erp_app login password 'erp_app' nobypassrls;
create database school_erp owner erp_migrator;
create database school_erp_test owner erp_migrator;
\connect school_erp
alter schema public owner to erp_migrator;
grant connect on database school_erp to erp_app;
\connect school_erp_test
alter schema public owner to erp_migrator;
grant connect on database school_erp_test to erp_app;
