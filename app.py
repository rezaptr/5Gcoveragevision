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

# ================= APP =================
app = Flask(__name__)
app.secret_key = 'dev'
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024

# ================= FOLDER =================
PROFILE_UPLOAD_FOLDER = 'static/uploads'
SHAPE_UPLOAD_FOLDER   = 'uploads/shapefile'

os.makedirs(PROFILE_UPLOAD_FOLDER, exist_ok=True)
os.makedirs(SHAPE_UPLOAD_FOLDER,   exist_ok=True)

app.config['PROFILE_UPLOAD_FOLDER'] = PROFILE_UPLOAD_FOLDER
app.config['SHAPE_UPLOAD_FOLDER']   = SHAPE_UPLOAD_FOLDER

# ================= CONNECTION POOL =================
# Buka koneksi sekali saat startup, reuse untuk semua request
# connect_timeout=5 → tidak hanging 30+ detik kalau DB lambat
db_pool = psycopg2.pool.SimpleConnectionPool(
    minconn=1,
    maxconn=10,
    dbname="DB_Pengguna",
    user="postgres",
    password="Oktober16",
    host="localhost",
    port="5432",
    connect_timeout=5
)

def get_db_connection():
    return db_pool.getconn()

def release_db_connection(conn):
    db_pool.putconn(conn)

# ================= VALIDASI =================
ALLOWED_IMAGE_EXT = {'png', 'jpg', 'jpeg'}
ALLOWED_FILE_EXT  = {'xlsx', 'xls'}

def allowed_image(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_IMAGE_EXT

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_FILE_EXT

# ================= ROLE =================
def role_required(allowed_roles):
    def decorator(f):
        @wraps(f)
        def wrap(*args, **kwargs):
            if 'role' not in session:
                return redirect(url_for('login'))
            if session['role'] not in allowed_roles:
                return render_template('403.html'), 403
            return f(*args, **kwargs)
        return wrap
    return decorator

# ================= AUTH =================
@app.route('/')
@app.route('/welcome')
def welcome():
    return render_template('welcome.html')

@app.route('/login', methods=['GET', 'POST'])
def login():
    if request.method == 'POST':
        email    = request.form['email']
        password = request.form['password']

        conn = get_db_connection()
        try:
            cur = conn.cursor()
            cur.execute("""
                SELECT id, role, full_name, password, profile_image
                FROM users WHERE email = %s
            """, (email,))
            user = cur.fetchone()
            cur.close()
        finally:
            release_db_connection(conn)

        if user and check_password_hash(user[3], password):
            session['user_id']       = user[0]
            session['role']          = user[1]
            session['full_name']     = user[2]
            session['email']         = email
            session['profile_image'] = user[4]
            return redirect(url_for('main'))
        else:
            flash("Email atau password salah!")
            return redirect(url_for('login'))

    return render_template('login.html')

@app.route('/signup', methods=['GET', 'POST'])
def signup():
    if request.method == 'POST':
        full_name       = request.form['full_name']
        email           = request.form['email']
        hashed_password = generate_password_hash(request.form['password'])
        role            = request.form['role']

        conn = get_db_connection()
        try:
            cur = conn.cursor()
            cur.execute("""
                INSERT INTO users (full_name, email, password, role)
                VALUES (%s, %s, %s, %s)
            """, (full_name, email, hashed_password, role))
            conn.commit()
            cur.close()
        finally:
            release_db_connection(conn)

        return redirect(url_for('login'))

    return render_template('signup.html')

# ================= PROFILE =================
@app.route('/profile')
def profile():
    if 'user_id' not in session:
        return redirect(url_for('login'))

    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute("SELECT full_name, email, role FROM users WHERE id = %s", (session['user_id'],))
        user = cur.fetchone()
        cur.close()
    finally:
        release_db_connection(conn)

    return render_template('profile.html', user=user)

@app.route('/upload_profile', methods=['POST'])
def upload_profile():
    file = request.files['profile_image']

    if file and allowed_image(file.filename):
        ext      = file.filename.rsplit('.', 1)[1].lower()
        filename = f"{uuid.uuid4()}.{ext}"
        file.save(os.path.join(app.config['PROFILE_UPLOAD_FOLDER'], filename))

        conn = get_db_connection()
        try:
            cursor = conn.cursor()
            cursor.execute(
                "UPDATE users SET profile_image = %s WHERE id = %s",
                (filename, session['user_id'])
            )
            conn.commit()
            cursor.close()
        finally:
            release_db_connection(conn)

        session['profile_image'] = filename

    return redirect(url_for('profile'))

@app.route('/change-password', methods=['POST'])
def change_password():
    if 'user_id' not in session:
        return redirect(url_for('login'))

    old_password     = request.form['old_password']
    new_password     = request.form['new_password']
    confirm_password = request.form['confirm_password']

    conn = get_db_connection()
    try:
        cur = conn.cursor()
        cur.execute("SELECT password FROM users WHERE id = %s", (session['user_id'],))
        user = cur.fetchone()

        # 1. Cek Password Lama
        if not user or not check_password_hash(user[0], old_password):
            flash("Password lama salah!", "danger") # Cukup satu kali, beri kategori danger
            cur.close()
            return redirect(url_for('profile'))

        # 2. Cek Konfirmasi Password Baru
        if new_password != confirm_password:
            flash("Konfirmasi password tidak cocok!", "danger") # Cukup satu kali, beri kategori danger
            cur.close()
            return redirect(url_for('profile'))

        # 3. Update Database jika semua valid
        hashed_password = generate_password_hash(new_password)
        cur.execute(
            "UPDATE users SET password = %s WHERE id = %s",
            (hashed_password, session['user_id'])
        )
        conn.commit()
        cur.close()
        
        flash("Password berhasil diubah!", "success") # Kategori success untuk warna hijau

    finally:
        release_db_connection(conn)

    return redirect(url_for('profile'))

# ================= PAGE ROUTES =================
@app.route('/main')
@role_required(['dt_engineer', 'rf_engineer'])
def main():
    start = time.time()
    result = render_template('main.html')
    print(f"[TIMER] /main render: {time.time() - start:.3f}s")
    return result

@app.route('/route')
@role_required(['dt_engineer', 'rf_engineer'])
def route():
    return render_template('route.html')

@app.route('/drivetest')
@role_required(['dt_engineer', 'rf_engineer'])
def drivetest():
    return render_template('drivetest.html')

@app.route('/coverage')
@role_required(['rf_engineer'])
def coverage():
    return render_template('coverage.html')

@app.route('/analysis')
@role_required(['rf_engineer'])
def analysis():
    return render_template('simulationcom.html')

@app.route('/evaluation')
@role_required(['rf_engineer'])
def evaluation():
    return render_template('evaluation.html')

@app.route('/newsite')
@role_required(['rf_engineer'])
def newsite():
    return render_template('newsite.html')

@app.route('/simulation_dt')
@role_required(['rf_engineer'])
def simulation_dt():
    return render_template('simulation_dt.html')

@app.route('/coveragecom')
@role_required(['rf_engineer'])
def coveragecom():
    return render_template('coveragecom.html')

@app.route('/help')
def help_page():
    return render_template('help.html')

@app.route('/about')
def about():
    return render_template('about.html')

# ================= API: UPLOAD SITE XLSX =================
@app.route('/api/upload-site', methods=['POST'])
def upload_site():
    if 'file' not in request.files:
        return jsonify({'error': 'Tidak ada file yang dikirim'}), 400

    file = request.files['file']

    if file.filename == '':
        return jsonify({'error': 'Nama file kosong'}), 400

    if not allowed_file(file.filename):
        return jsonify({'error': 'Format file harus .xlsx atau .xls'}), 400

    filename = secure_filename(file.filename)
    filepath = os.path.join(app.config['SHAPE_UPLOAD_FOLDER'], filename)
    file.save(filepath)

    try:
        site_index = parse_xlsx(filepath)
    except Exception as e:
        return jsonify({'error': f'Gagal parsing XLSX: {str(e)}'}), 500

    if not site_index:
        return jsonify({'error': 'Tidak ada data site valid di file ini'}), 400

    # Simpan nama file ke session — halaman lain bisa GET tanpa upload ulang
    session['site_filename'] = filename

    return jsonify({
        'success'  : True,
        'filename' : filename,
        'siteCount': len(site_index),
        'siteIndex': site_index
    })

# ================= API: GET SITE (pakai session, tanpa upload ulang) =================
@app.route('/api/get-site', methods=['GET'])
def get_site():
    """
    Halaman lain (route.html, drivetest.html, dll) tinggal GET /api/get-site
    tanpa perlu upload ulang. Data diambil dari file yang sudah disimpan.
    """
    filename = session.get('site_filename')

    if not filename:
        return jsonify({'error': 'Belum ada file site yang di-upload', 'has_site': False}), 404

    filepath = os.path.join(app.config['SHAPE_UPLOAD_FOLDER'], filename)

    if not os.path.exists(filepath):
        session.pop('site_filename', None)
        return jsonify({'error': 'File tidak ditemukan, silakan upload ulang', 'has_site': False}), 404

    try:
        site_index = parse_xlsx(filepath)
    except Exception as e:
        return jsonify({'error': f'Gagal membaca file: {str(e)}'}), 500

    return jsonify({
        'success'   : True,
        'has_site'  : True,
        'filename'  : filename,
        'siteCount' : len(site_index),
        'siteIndex' : site_index
    })

# ================= PARSE XLSX =================
# Fix v2:
#   - Blok sectors/pciList masuk ke DALAM loop for row (indentasi benar)
#   - pciList diinisialisasi bersamaan dengan sectors saat site pertama dibuat
#   - Hapus blok 'if pciList not in...' yang salah posisi
# =================================================
# ================= PARSE XLSX (PATCHED - SUPPORT sectorData) =================
CLUTTER_SCENARIO = {
    'dense urban': ('umi','nlos'),
    'metropolitan': ('umi','nlos'),
    'urban': ('uma','nlos'),
    'sub urban': ('uma','los_nlos'),
    'suburban': ('uma','los_nlos'),
    'rural': ('rma','los_nlos'),
    'open': ('rma','los'),
}

def get_scenario_condition(c):
    return CLUTTER_SCENARIO.get((c or '').strip().lower(), ('uma','nlos'))

def parse_xlsx(filepath):
    wb = openpyxl.load_workbook(filepath, read_only=True, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    wb.close()

    raw_headers = [str(h).strip() if h is not None else '' for h in rows[0]]
    headers = [h.upper() for h in raw_headers]

    def col(name):
        try:
            return headers.index(name.upper())
        except ValueError:
            return None

    c_site = col('SITE_ID')
    c_lat  = col('LAT')
    c_lng  = col('LONG')
    c_pci  = col('PCI')
    c_az   = col('AZIMUTH')

    c_height   = col('HEIGHT')
    c_clutter  = col('CLUTTER')
    c_sec      = col('SEC')
    c_gnb      = col('GNODEB_ID')
    c_cellid   = col('CELL_ID')
    c_cellname = col('CELL_NAME')
    c_arfcn    = col('DL_NARFCN')

    if any(c is None for c in [c_site, c_lat, c_lng, c_pci, c_az]):
        raise ValueError("Kolom wajib tidak lengkap (SITE_ID, LAT, LONG, PCI, AZIMUTH)")

    raw_rows = []

    for row in rows[1:]:
        try:
            site_id = str(row[c_site]).strip() if row[c_site] else None
            if not site_id:
                continue

            lat = float(row[c_lat])
            lng = float(row[c_lng])
            az  = float(row[c_az])

            pci = int(float(row[c_pci])) if row[c_pci] not in (None, '', 'N/A') else None
            height = float(row[c_height]) if c_height and row[c_height] else 30.0
            clutter = str(row[c_clutter]).strip() if c_clutter and row[c_clutter] else 'N/A'

            sec_num  = int(float(row[c_sec])) if c_sec and row[c_sec] else None
            gnb_id   = int(float(row[c_gnb])) if c_gnb and row[c_gnb] else None
            cell_id  = int(float(row[c_cellid])) if c_cellid and row[c_cellid] else None
            cell_name= str(row[c_cellname]).strip() if c_cellname and row[c_cellname] else None
            arfcn    = int(float(row[c_arfcn])) if c_arfcn and row[c_arfcn] else 466850

            raw_rows.append({
                'siteId': site_id,
                'lat': lat,
                'lng': lng,
                'height': height,
                'pci': pci,
                'azimuth': az,
                'secNum': sec_num,
                'gnbId': gnb_id,
                'cellId': cell_id,
                'cellName': cell_name,
                'arfcn': arfcn,
                'clutter': clutter,
            })
        except:
            continue

    # group by site
    site_rows = {}
    for r in raw_rows:
        site_rows.setdefault(r['siteId'], []).append(r)

    siteIndex = {}

    for sid, rows_site in site_rows.items():
        rows_sorted = sorted(rows_site, key=lambda r: r['azimuth'])
        first = rows_sorted[0]

        scenario, condition = get_scenario_condition(first['clutter'])

        sector_data = []
        seen_az = set()
        sec_counter = 1

        for r in rows_sorted:
            az_key = round(r['azimuth'])
            if az_key in seen_az:
                continue
            seen_az.add(az_key)

            sec_num = r['secNum'] if r['secNum'] else sec_counter
            sec_counter += 1

            cell_name = r['cellName'] or f"{sid}_S{sec_num}"

            sector_data.append({
                'sectorNum': sec_num,
                'azimuth': r['azimuth'],
                'pci': r['pci'],
                'cellId': r['cellId'],
                'cellName': cell_name,
                'gnbId': r['gnbId'],
                'arfcn': r['arfcn'],
            })

        if not sector_data:
            continue

        siteIndex[sid] = {
            'lat': first['lat'],
            'lng': first['lng'],
            'height': first['height'],
            'gnbId': first['gnbId'],
            'clutter': first['clutter'],
            'scenario': scenario,
            'condition': condition,
            'sectors': [s['azimuth'] for s in sector_data],  # backward compat
            'sectorData': sector_data                         # NEW (dipakai JS)
        }

    print(f"[parse_xlsx] {len(siteIndex)} sites")
    return siteIndex

# ================= RUN =================
if __name__ == "__main__":
    app.run(debug=True)