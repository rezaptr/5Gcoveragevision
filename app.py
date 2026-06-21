import os
import math
import uuid
import time
from flask import Flask, render_template, request, jsonify, session, redirect, url_for, flash
from werkzeug.utils import secure_filename
from werkzeug.security import generate_password_hash, check_password_hash
import openpyxl
import psycopg2
from psycopg2 import pool
from functools import wraps

print(f"[STARTUP] PORT env = {os.getenv('PORT')}")
print(f"[STARTUP] DATABASE_URL set = {bool(os.getenv('DATABASE_URL'))}")

# ================= APP =================
app = Flask(__name__)
app.secret_key = os.getenv("SECRET_KEY", "dev")
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024

# ================= FOLDER =================
PROFILE_UPLOAD_FOLDER = "static/uploads"
SHAPE_UPLOAD_FOLDER   = "uploads/shapefile"

os.makedirs(PROFILE_UPLOAD_FOLDER, exist_ok=True)
os.makedirs(SHAPE_UPLOAD_FOLDER,   exist_ok=True)

app.config["PROFILE_UPLOAD_FOLDER"] = PROFILE_UPLOAD_FOLDER
app.config["SHAPE_UPLOAD_FOLDER"]   = SHAPE_UPLOAD_FOLDER

# ================= CONNECTION POOL =================
DATABASE_URL = os.getenv("DATABASE_URL")

if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL environment variable is not set!")

db_pool = None

def get_db_pool():
    global db_pool
    if db_pool is None:
        db_pool = psycopg2.pool.SimpleConnectionPool(
            minconn=1,
            maxconn=10,
            dsn=DATABASE_URL,
            connect_timeout=5
        )
    return db_pool

def get_db_connection():
    return get_db_pool().getconn()

def release_db_connection(conn):
    get_db_pool().putconn(conn)
