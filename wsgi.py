"""WSGI entry point for containers: gunicorn --preload wsgi:app
Creates/upgrades the tables and seeds demo data once, before workers start."""
from server import app, init_database

with app.app_context():
    init_database()
