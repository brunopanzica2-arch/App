"""initial schema

Revision ID: 0001
Revises: 
Create Date: 2026-10-09
"""
from alembic import op
import sqlalchemy as sa
import geoalchemy2
from geoalchemy2 import Geography
from sqlalchemy.dialects import postgresql

revision = '0001'
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS postgis")
    op.create_table('geocoding_cache',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('provider', sa.String(length=40), nullable=False),
    sa.Column('query_hash', sa.String(length=64), nullable=False),
    sa.Column('query', sa.Text(), nullable=False),
    sa.Column('response', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('provider', 'query_hash', name='uq_geocache')
    )
    op.create_table('organizations',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('settings', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_table('jobs',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('org_id', sa.UUID(), nullable=False),
    sa.Column('kind', sa.String(length=40), nullable=False),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('progress', sa.Float(), nullable=False),
    sa.Column('params', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('result', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('error', sa.Text(), nullable=True),
    sa.Column('timings', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_jobs_org_id'), 'jobs', ['org_id'], unique=False)
    op.create_table('users',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('org_id', sa.UUID(), nullable=False),
    sa.Column('email', sa.String(length=320), nullable=False),
    sa.Column('name', sa.String(length=200), nullable=False),
    sa.Column('password_hash', sa.String(length=200), nullable=False),
    sa.Column('role', sa.String(length=20), nullable=False),
    sa.Column('can_view_recipients', sa.Boolean(), nullable=False),
    sa.Column('active', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('email')
    )
    op.create_index(op.f('ix_users_org_id'), 'users', ['org_id'], unique=False)
    op.create_geospatial_table('addresses',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('org_id', sa.UUID(), nullable=False),
    sa.Column('normalized_key', sa.String(length=400), nullable=False),
    sa.Column('original_text', sa.Text(), nullable=False),
    sa.Column('normalized_text', sa.Text(), nullable=False),
    sa.Column('street_type', sa.String(length=40), nullable=True),
    sa.Column('street_name', sa.String(length=300), nullable=False),
    sa.Column('number', sa.String(length=20), nullable=True),
    sa.Column('neighborhood', sa.String(length=120), nullable=True),
    sa.Column('city', sa.String(length=120), nullable=False),
    sa.Column('state', sa.String(length=2), nullable=False),
    sa.Column('cep', sa.String(length=9), nullable=True),
    sa.Column('geocode_query', sa.Text(), nullable=True),
    sa.Column('lat', sa.Float(), nullable=True),
    sa.Column('lon', sa.Float(), nullable=True),
    sa.Column('geom', Geography(geometry_type='POINT', srid=4326, dimension=2, spatial_index=False, from_text='ST_GeogFromText', name='geography'), nullable=True),
    sa.Column('precision', sa.String(length=20), nullable=False),
    sa.Column('confidence', sa.Float(), nullable=False),
    sa.Column('source', sa.String(length=40), nullable=True),
    sa.Column('provider_ref', sa.String(length=120), nullable=True),
    sa.Column('candidates', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('needs_review', sa.Boolean(), nullable=False),
    sa.Column('review_reason', sa.Text(), nullable=True),
    sa.Column('verified_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('confirmed_by', sa.UUID(), nullable=True),
    sa.Column('confirmed_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['confirmed_by'], ['users.id'], ),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('org_id', 'normalized_key', name='uq_address_key')
    )
    op.create_geospatial_index('ix_addresses_geom', 'addresses', ['geom'], unique=False, postgresql_using='gist', postgresql_ops={})
    op.create_index(op.f('ix_addresses_org_id'), 'addresses', ['org_id'], unique=False)
    op.create_table('audit_logs',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('org_id', sa.UUID(), nullable=True),
    sa.Column('user_id', sa.UUID(), nullable=True),
    sa.Column('action', sa.String(length=80), nullable=False),
    sa.Column('entity', sa.String(length=60), nullable=False),
    sa.Column('entity_id', sa.String(length=80), nullable=True),
    sa.Column('details', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('ip', sa.String(length=64), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_audit_logs_created_at'), 'audit_logs', ['created_at'], unique=False)
    op.create_index(op.f('ix_audit_logs_org_id'), 'audit_logs', ['org_id'], unique=False)
    op.create_table('delivery_batches',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('org_id', sa.UUID(), nullable=False),
    sa.Column('reference', sa.String(length=120), nullable=False),
    sa.Column('service_date', sa.Date(), nullable=False),
    sa.Column('source_type', sa.String(length=20), nullable=False),
    sa.Column('original_filename', sa.String(length=300), nullable=True),
    sa.Column('content_sha256', sa.String(length=64), nullable=True),
    sa.Column('original_content', sa.Text(), nullable=True),
    sa.Column('options', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('column_mapping', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('row_count', sa.Integer(), nullable=False),
    sa.Column('error_count', sa.Integer(), nullable=False),
    sa.Column('import_report', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('created_by', sa.UUID(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], ),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_delivery_batches_content_sha256'), 'delivery_batches', ['content_sha256'], unique=False)
    op.create_index(op.f('ix_delivery_batches_org_id'), 'delivery_batches', ['org_id'], unique=False)
    op.create_table('sync_events',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('org_id', sa.UUID(), nullable=False),
    sa.Column('user_id', sa.UUID(), nullable=False),
    sa.Column('client_id', sa.String(length=80), nullable=False),
    sa.Column('client_event_id', sa.String(length=80), nullable=False),
    sa.Column('kind', sa.String(length=40), nullable=False),
    sa.Column('payload', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('result', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('received_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('user_id', 'client_event_id', name='uq_sync_client_event')
    )
    op.create_index(op.f('ix_sync_events_org_id'), 'sync_events', ['org_id'], unique=False)
    op.create_table('correspondences',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('org_id', sa.UUID(), nullable=False),
    sa.Column('batch_id', sa.UUID(), nullable=False),
    sa.Column('row_number', sa.Integer(), nullable=False),
    sa.Column('external_id', sa.String(length=80), nullable=True),
    sa.Column('raw_row', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('recipient', sa.String(length=300), nullable=True),
    sa.Column('street', sa.String(length=300), nullable=True),
    sa.Column('number', sa.String(length=20), nullable=True),
    sa.Column('complement', sa.String(length=200), nullable=True),
    sa.Column('neighborhood', sa.String(length=120), nullable=True),
    sa.Column('city', sa.String(length=120), nullable=True),
    sa.Column('cep', sa.String(length=9), nullable=True),
    sa.Column('notes', sa.Text(), nullable=True),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('validation_errors', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('excluded', sa.Boolean(), nullable=False),
    sa.Column('exclusion_reason', sa.Text(), nullable=True),
    sa.Column('address_id', sa.UUID(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['address_id'], ['addresses.id'], ),
    sa.ForeignKeyConstraint(['batch_id'], ['delivery_batches.id'], ),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_correspondences_address_id'), 'correspondences', ['address_id'], unique=False)
    op.create_index(op.f('ix_correspondences_batch_id'), 'correspondences', ['batch_id'], unique=False)
    op.create_index(op.f('ix_correspondences_org_id'), 'correspondences', ['org_id'], unique=False)
    op.create_index(op.f('ix_correspondences_status'), 'correspondences', ['status'], unique=False)
    op.create_index('uq_corr_external_id', 'correspondences', ['org_id', 'external_id'], unique=True, postgresql_where=sa.text('external_id IS NOT NULL'))
    op.create_geospatial_table('routes',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('org_id', sa.UUID(), nullable=False),
    sa.Column('batch_id', sa.UUID(), nullable=False),
    sa.Column('version', sa.Integer(), nullable=False),
    sa.Column('parent_route_id', sa.UUID(), nullable=True),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('route_mode', sa.String(length=20), nullable=False),
    sa.Column('strategy', sa.String(length=20), nullable=False),
    sa.Column('start_label', sa.Text(), nullable=False),
    sa.Column('start_lat', sa.Float(), nullable=False),
    sa.Column('start_lon', sa.Float(), nullable=False),
    sa.Column('end_label', sa.Text(), nullable=True),
    sa.Column('end_lat', sa.Float(), nullable=True),
    sa.Column('end_lon', sa.Float(), nullable=True),
    sa.Column('profile', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('engine', sa.String(length=40), nullable=False),
    sa.Column('network_version', sa.String(length=64), nullable=True),
    sa.Column('total_time_s', sa.Float(), nullable=False),
    sa.Column('travel_time_s', sa.Float(), nullable=False),
    sa.Column('service_time_s', sa.Float(), nullable=False),
    sa.Column('total_distance_m', sa.Float(), nullable=False),
    sa.Column('metrics', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('candidates', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('geojson', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('geom', Geography(geometry_type='MULTILINESTRING', srid=4326, dimension=2, spatial_index=False, from_text='ST_GeogFromText', name='geography'), nullable=True),
    sa.Column('warnings', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('diff', sa.JSON().with_variant(postgresql.JSONB(astext_type=sa.Text()), 'postgresql'), nullable=False),
    sa.Column('created_by', sa.UUID(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['batch_id'], ['delivery_batches.id'], ),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], ),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ),
    sa.ForeignKeyConstraint(['parent_route_id'], ['routes.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('batch_id', 'version', name='uq_route_version')
    )
    op.create_index(op.f('ix_routes_batch_id'), 'routes', ['batch_id'], unique=False)
    op.create_index(op.f('ix_routes_org_id'), 'routes', ['org_id'], unique=False)
    op.create_geospatial_table('stops',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('org_id', sa.UUID(), nullable=False),
    sa.Column('batch_id', sa.UUID(), nullable=False),
    sa.Column('address_id', sa.UUID(), nullable=False),
    sa.Column('lat', sa.Float(), nullable=False),
    sa.Column('lon', sa.Float(), nullable=False),
    sa.Column('geom', Geography(geometry_type='POINT', srid=4326, dimension=2, spatial_index=False, from_text='ST_GeogFromText', name='geography'), nullable=True),
    sa.Column('service_time_s', sa.Float(), nullable=True),
    sa.Column('priority', sa.Integer(), nullable=False),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('excluded', sa.Boolean(), nullable=False),
    sa.Column('exclusion_reason', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['address_id'], ['addresses.id'], ),
    sa.ForeignKeyConstraint(['batch_id'], ['delivery_batches.id'], ),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('batch_id', 'address_id', name='uq_stop_batch_address')
    )
    op.create_geospatial_index('idx_stops_geom', 'stops', ['geom'], unique=False, postgresql_using='gist', postgresql_ops={})
    op.create_index(op.f('ix_stops_batch_id'), 'stops', ['batch_id'], unique=False)
    op.create_index(op.f('ix_stops_org_id'), 'stops', ['org_id'], unique=False)
    op.create_table('delivery_events',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('org_id', sa.UUID(), nullable=False),
    sa.Column('correspondence_id', sa.UUID(), nullable=False),
    sa.Column('stop_id', sa.UUID(), nullable=True),
    sa.Column('route_id', sa.UUID(), nullable=True),
    sa.Column('user_id', sa.UUID(), nullable=False),
    sa.Column('previous_status', sa.String(length=20), nullable=False),
    sa.Column('status', sa.String(length=20), nullable=False),
    sa.Column('reason', sa.String(length=120), nullable=True),
    sa.Column('notes', sa.Text(), nullable=True),
    sa.Column('corrects_event_id', sa.UUID(), nullable=True),
    sa.Column('occurred_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('received_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('client_event_id', sa.String(length=80), nullable=True),
    sa.Column('source', sa.String(length=20), nullable=False),
    sa.ForeignKeyConstraint(['corrects_event_id'], ['delivery_events.id'], ),
    sa.ForeignKeyConstraint(['correspondence_id'], ['correspondences.id'], ),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ),
    sa.ForeignKeyConstraint(['route_id'], ['routes.id'], ),
    sa.ForeignKeyConstraint(['stop_id'], ['stops.id'], ),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('client_event_id')
    )
    op.create_index(op.f('ix_delivery_events_correspondence_id'), 'delivery_events', ['correspondence_id'], unique=False)
    op.create_index(op.f('ix_delivery_events_org_id'), 'delivery_events', ['org_id'], unique=False)
    op.create_table('route_matrix_metadata',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('org_id', sa.UUID(), nullable=False),
    sa.Column('route_id', sa.UUID(), nullable=True),
    sa.Column('engine', sa.String(length=40), nullable=False),
    sa.Column('network_version', sa.String(length=64), nullable=True),
    sa.Column('profile_hash', sa.String(length=64), nullable=False),
    sa.Column('points_hash', sa.String(length=64), nullable=False),
    sa.Column('n_points', sa.Integer(), nullable=False),
    sa.Column('unreachable_pairs', sa.Integer(), nullable=False),
    sa.Column('compute_ms', sa.Integer(), nullable=False),
    sa.Column('storage_path', sa.Text(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['org_id'], ['organizations.id'], ),
    sa.ForeignKeyConstraint(['route_id'], ['routes.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_route_matrix_metadata_org_id'), 'route_matrix_metadata', ['org_id'], unique=False)
    op.create_index(op.f('ix_route_matrix_metadata_points_hash'), 'route_matrix_metadata', ['points_hash'], unique=False)
    op.create_table('route_stops',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('route_id', sa.UUID(), nullable=False),
    sa.Column('stop_id', sa.UUID(), nullable=False),
    sa.Column('sequence', sa.Integer(), nullable=False),
    sa.Column('eta_s', sa.Float(), nullable=False),
    sa.Column('leg_distance_m', sa.Float(), nullable=False),
    sa.Column('leg_time_s', sa.Float(), nullable=False),
    sa.Column('snap_lat', sa.Float(), nullable=True),
    sa.Column('snap_lon', sa.Float(), nullable=True),
    sa.Column('snap_distance_m', sa.Float(), nullable=True),
    sa.Column('locked', sa.Boolean(), nullable=False),
    sa.Column('status_at_plan', sa.String(length=20), nullable=False),
    sa.ForeignKeyConstraint(['route_id'], ['routes.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['stop_id'], ['stops.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('route_id', 'sequence', name='uq_route_seq')
    )
    op.create_index(op.f('ix_route_stops_route_id'), 'route_stops', ['route_id'], unique=False)
    op.create_table('stop_correspondences',
    sa.Column('stop_id', sa.UUID(), nullable=False),
    sa.Column('correspondence_id', sa.UUID(), nullable=False),
    sa.ForeignKeyConstraint(['correspondence_id'], ['correspondences.id'], ),
    sa.ForeignKeyConstraint(['stop_id'], ['stops.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('stop_id', 'correspondence_id'),
    sa.UniqueConstraint('correspondence_id')
    )



def downgrade() -> None:

    op.drop_table('stop_correspondences')
    op.drop_index(op.f('ix_route_stops_route_id'), table_name='route_stops')
    op.drop_table('route_stops')
    op.drop_index(op.f('ix_route_matrix_metadata_points_hash'), table_name='route_matrix_metadata')
    op.drop_index(op.f('ix_route_matrix_metadata_org_id'), table_name='route_matrix_metadata')
    op.drop_table('route_matrix_metadata')
    op.drop_index(op.f('ix_delivery_events_org_id'), table_name='delivery_events')
    op.drop_index(op.f('ix_delivery_events_correspondence_id'), table_name='delivery_events')
    op.drop_table('delivery_events')
    op.drop_index(op.f('ix_stops_org_id'), table_name='stops')
    op.drop_index(op.f('ix_stops_batch_id'), table_name='stops')
    op.drop_geospatial_index('idx_stops_geom', table_name='stops', postgresql_using='gist', column_name='geom')
    op.drop_geospatial_table('stops')
    op.drop_index(op.f('ix_routes_org_id'), table_name='routes')
    op.drop_index(op.f('ix_routes_batch_id'), table_name='routes')
    op.drop_geospatial_table('routes')
    op.drop_index('uq_corr_external_id', table_name='correspondences', postgresql_where=sa.text('external_id IS NOT NULL'))
    op.drop_index(op.f('ix_correspondences_status'), table_name='correspondences')
    op.drop_index(op.f('ix_correspondences_org_id'), table_name='correspondences')
    op.drop_index(op.f('ix_correspondences_batch_id'), table_name='correspondences')
    op.drop_index(op.f('ix_correspondences_address_id'), table_name='correspondences')
    op.drop_table('correspondences')
    op.drop_index(op.f('ix_sync_events_org_id'), table_name='sync_events')
    op.drop_table('sync_events')
    op.drop_index(op.f('ix_delivery_batches_org_id'), table_name='delivery_batches')
    op.drop_index(op.f('ix_delivery_batches_content_sha256'), table_name='delivery_batches')
    op.drop_table('delivery_batches')
    op.drop_index(op.f('ix_audit_logs_org_id'), table_name='audit_logs')
    op.drop_index(op.f('ix_audit_logs_created_at'), table_name='audit_logs')
    op.drop_table('audit_logs')
    op.drop_index(op.f('ix_addresses_org_id'), table_name='addresses')
    op.drop_geospatial_index('ix_addresses_geom', table_name='addresses', postgresql_using='gist', column_name='geom')
    op.drop_geospatial_table('addresses')
    op.drop_index(op.f('ix_users_org_id'), table_name='users')
    op.drop_table('users')
    op.drop_index(op.f('ix_jobs_org_id'), table_name='jobs')
    op.drop_table('jobs')
    op.drop_table('organizations')
    op.drop_table('geocoding_cache')

