import type Database from "better-sqlite3";

/** Additive application state only; never edits the provider's own databases. */
export function migrateProjectConsole(db: Database.Database): void {
  db.exec(`
    create table console_projects (
      id text primary key, root text not null unique, name text not null, created_at text not null
    );
    create table console_work_items (
      id text primary key, project_id text not null references console_projects(id),
      item_key text not null, title text not null, created_at text not null
    );
    create table console_work_runs (
      id text primary key, project_id text not null references console_projects(id),
      item_id text not null references console_work_items(id), workspace_id text,
      run_key text not null, request_hash text not null, origin text not null,
      status text not null default 'running', acceptance text not null default 'pending',
      summary text not null default '', evidence text not null default '[]',
      revision integer not null default 1, created_at text not null, finished_at text
    );
    create index console_runs_project on console_work_runs(project_id, created_at desc, id);
    create table console_operations (
      id text primary key, run_id text not null references console_work_runs(id),
      request_key text not null, kind text not null, label text not null,
      status text not null, evidence text not null default '[]', created_at text not null, finished_at text
    );
    create table console_threads (
      id text primary key, project_id text not null references console_projects(id),
      agent_id text not null references local_agent_sessions(id), instance_id text not null,
      thread_id text not null, created_here integer not null, identity_verified integer not null,
      origin text not null, title text not null, name_status text not null default 'pending',
      external_activity integer not null default 0, protected integer not null default 0,
      archive_state text not null default 'active', revision integer not null default 1,
      created_at text not null, updated_at text not null
    );
    create index console_threads_project on console_threads(project_id, updated_at desc);
    create table console_executions (
      id text primary key, run_id text not null references console_work_runs(id),
      agent_id text not null references local_agent_sessions(id), provider text not null,
      managed_thread_id text references console_threads(id), provider_turn_id text,
      status text not null, requested integer not null default 0, provider_finished integer not null default 0,
      baseline text, cumulative text, delta text, usage_quality text not null default 'not_used',
      boundary_reason text not null default 'no_provider_request', requested_model text, requested_effort text,
      created_at text not null, finished_at text
    );
    create index console_exec_run on console_executions(run_id, created_at);
    create index console_exec_agent on console_executions(agent_id, created_at desc);
    create unique index console_exec_provider_turn on console_executions(managed_thread_id, provider_turn_id)
      where provider_turn_id is not null;
    create table console_archive_batches (
      id text primary key, project_id text not null references console_projects(id),
      mode text not null, status text not null, request_hash text not null,
      accept_partial integer not null, external_idle integer not null, created_at text not null,
      expires_at text not null, updated_at text not null
    );
    create table console_archive_entries (
      batch_id text not null references console_archive_batches(id),
      managed_thread_id text not null references console_threads(id),
      expected_revision integer not null, expected_snapshot text, status text not null,
      reason text, updated_at text not null,
      primary key(batch_id, managed_thread_id)
    );
    create unique index console_item_identity on console_work_items(project_id, item_key);
    create unique index console_run_identity on console_work_runs(item_id, run_key);
    create unique index console_operation_identity on console_operations(run_id, request_key);
    create unique index console_thread_identity on console_threads(instance_id, thread_id);
  `);
}
