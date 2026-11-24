import { startSession, authFetch, onSessionEnd, getProfile } from "/auth.js";

onSessionEnd(() => { location.href = "/"; });
if (!(await startSession())) location.href = "/";

const profile = getProfile();

// Set profile data from localStorage (safe - skip if element missing)
const setTextSafe = (id, value) => {
  const el = document.getElementById(id);
  if (el) el.textContent = value || '-';
};

setTextSafe('profil-id', profile?.id);
setTextSafe('profil-nama', profile?.nama_karyawan);
setTextSafe('profil-penugasan', profile?.penugasan);
setTextSafe('profil-jabatan', profile?.jabatan);

// Fetch full profile from API ONLY if jabatan is missing
// ponytail: cache optimization - only fetch when data incomplete
async function loadProfileJabatan() {
  // Skip API call if jabatan already in localStorage
  if (profile?.jabatan) {
    return;
  }
  
  try {
    const res = await authFetch('/api/profile');
    if (res.ok) {
      const responseData = await res.json();
      // ponytail: API returns nested structure: { status, data: { jabatan, ... } }
      const data = responseData.data || responseData;
      
      if (data?.jabatan) {
        // Update UI
        document.getElementById('profil-jabatan').textContent = data.jabatan;
        
        // Update localStorage profile cache
        const updatedProfile = { ...profile, jabatan: data.jabatan };
        localStorage.setItem('auth_profile', JSON.stringify(updatedProfile));
      }
    }
  } catch (e) {
    console.error('Failed to load jabatan:', e);
  }
}

loadProfileJabatan();

// Set default date range (last 30 days)
const today = new Date();
const thirtyDaysAgo = new Date(today);
thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

// ponytail: format dates as YYYY-MM-DD for API query
// sampai = today, dari = today - 30 days
const formatDate = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

document.getElementById('rw-sampai').value = formatDate(today);
document.getElementById('rw-dari').value = formatDate(thirtyDaysAgo);
document.getElementById('rw-sampai').max = formatDate(today);

// Date change listeners
document.getElementById('rw-dari').addEventListener('change', validateAndLoad);
document.getElementById('rw-sampai').addEventListener('change', validateAndLoad);

function validateAndLoad() {
  const dari = new Date(document.getElementById('rw-dari').value);
  const sampai = new Date(document.getElementById('rw-sampai').value);
  
  // Validate: max 31 days
  const diffDays = Math.floor((sampai - dari) / (1000 * 60 * 60 * 24));
  
  if (diffDays > 31) {
    alert('Periode maksimal 1 bulan (31 hari)');
    return;
  }
  
  if (diffDays < 0) {
    alert('Tanggal mulai harus lebih awal dari tanggal akhir');
    return;
  }
  
  // Update min/max constraints
  document.getElementById('rw-sampai').min = document.getElementById('rw-dari').value;
  document.getElementById('rw-dari').max = document.getElementById('rw-sampai').value;
  
  loadRiwayat();
}

async function loadRiwayat() {
  const dari = document.getElementById('rw-dari').value;
  const sampai = document.getElementById('rw-sampai').value;
  
  document.getElementById('loading').style.display = 'block';
  document.getElementById('riwayat-list').innerHTML = '';
  
  try {
    const res = await authFetch(`/api/status?dari=${dari}&sampai=${sampai}`);
    
    // ponytail: check response status before parsing JSON
    if (!res.ok) {
      throw new Error(`API error: ${res.status}`);
    }
    
    const data = await res.json();
    
    document.getElementById('loading').style.display = 'none';
    
    if (!Array.isArray(data) || data.length === 0) {
      showEmptyState();
      updateStats(0, 0, 0);
      return;
    }
    
    renderRiwayat(data);
    calculateStats(data);
    
  } catch (e) {
    console.error('Riwayat load error:', e);
    document.getElementById('loading').style.display = 'none';
    showError();
  }
}

function renderRiwayat(data) {
  const container = document.getElementById('riwayat-list');
  container.innerHTML = '';
  
  data.forEach(item => {
    const div = document.createElement('div');
    div.className = 'rw-item';
    
    // ponytail: API returns 'tanggal' not 'tanggal_datang'
    const tanggal = formatTanggal(item.tanggal || item.tanggal_datang);
    const jamMasuk = item.jam_datang || '--:--';
    const jamKeluar = item.jam_pulang || '--:--';
    const alamat = item.alamat_datang || item.alamat_pulang || 'Lokasi tidak tercatat';
    
    div.innerHTML = `
      <div class="rw-item-tanggal">${tanggal}</div>
      <div class="rw-item-jam">
        <div class="rw-jam">
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 8v-2a2 2 0 0 0 -2 -2h-7a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2 -2v-2"></path>
            <path d="M21 12h-13l3 -3"></path>
            <path d="M11 15l-3 -3"></path>
          </svg>
          <span class="rw-jam-lbl">Masuk</span>
          <span class="rw-jam-val">${jamMasuk}</span>
        </div>
        <div class="rw-jam">
          <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 8v-2a2 2 0 0 0 -2 -2h-7a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2 -2v-2"></path>
            <path d="M9 12h12l-3 -3"></path>
            <path d="M18 15l3 -3"></path>
          </svg>
          <span class="rw-jam-lbl">Keluar</span>
          <span class="rw-jam-val">${jamKeluar}</span>
        </div>
      </div>
      <div class="rw-item-alamat">${alamat}</div>
    `;
    
    container.appendChild(div);
  });
}

function formatTanggal(dateStr) {
  // ponytail: parse date string properly - API returns 'YYYY-MM-DD' format
  // Use UTC to avoid timezone offset issues
  const parts = dateStr.split('-');
  const date = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
  
  const hari = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  const bulan = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
  
  return `${hari[date.getDay()]}, ${date.getDate()} ${bulan[date.getMonth()]}`;
}

function calculateStats(data) {
  const tercatat = data.length;
  const lengkap = data.filter(d => d.jam_datang && d.jam_pulang).length;
  const belumPulang = data.filter(d => d.jam_datang && !d.jam_pulang).length;
  
  updateStats(tercatat, lengkap, belumPulang);
}

function updateStats(tercatat, lengkap, belum) {
  document.getElementById('stat-tercatat').textContent = tercatat;
  document.getElementById('stat-lengkap').textContent = lengkap;
  document.getElementById('stat-belum').textContent = belum;
}

function showEmptyState() {
  const container = document.getElementById('riwayat-list');
  container.innerHTML = `
    <div class="empty-state">
      <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M12 8l0 4l2 2"></path>
        <path d="M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5"></path>
      </svg>
      <h3>Tidak Ada Data</h3>
      <p>Belum ada riwayat absensi pada periode ini</p>
    </div>
  `;
}

function showError() {
  const container = document.getElementById('riwayat-list');
  container.innerHTML = `
    <div class="empty-state">
      <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M12 9v4"></path>
        <path d="M12 17h.01"></path>
        <path d="M12 3c7.2 0 9 1.8 9 9s-1.8 9 -9 9s-9 -1.8 -9 -9s1.8 -9 9 -9z"></path>
      </svg>
      <h3>Gagal Memuat</h3>
      <p>Terjadi kesalahan saat memuat data</p>
    </div>
  `;
}

// Load initial data after DOM ready
console.log('[RIWAYAT] Initializing...');
console.log('[RIWAYAT] dari:', document.getElementById('rw-dari')?.value);
console.log('[RIWAYAT] sampai:', document.getElementById('rw-sampai')?.value);
loadRiwayat();
