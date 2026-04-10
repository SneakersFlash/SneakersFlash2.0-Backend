// ==========================================
// SCRIPT 2 FINAL - JANE PATRICIA (2 TIKET)
// ==========================================

const TARGET_TIKET = {
    pilihanPertama: "CAT 4",
    pilihanKedua: "CAT 5",
    jumlah: 2
};

const DATA_PEMBELI = {
    nama_lengkap: "Jane Patricia", 
    email: "itsjaneptrc@gmail.com",           
    nomor_hp: "081510604516",                
    nomor_ktp: "3171025506030004"            
};

// 1. Pilih Kategori & Klik tombol '+' sebanyak 2 kali
const kategori = Array.from(document.querySelectorAll('*')).filter(el => el.innerText && (el.innerText.includes(TARGET_TIKET.pilihanPertama) || el.innerText.includes(TARGET_TIKET.pilihanKedua)));
if(kategori.length > 0) {
    const tombolPlus = kategori[0].parentElement.querySelector('.btn-plus, .add, button:contains("+")');
    if(tombolPlus) {
        for(let i = 0; i < TARGET_TIKET.jumlah; i++) {
            tombolPlus.click();
        }
    }
}

// 2. Klik Lanjut
setTimeout(() => {
    const btnLanjut = document.querySelector('.btn-next, .checkout, button:contains("Lanjut")');
    if(btnLanjut) btnLanjut.click();
}, 500);

// 3. Isi Data Diri & Centang T&C
setTimeout(() => {
    const n = document.querySelector('input[name*="name"], input[name*="full"]'); if(n) n.value = DATA_PEMBELI.nama_lengkap;
    const e = document.querySelector('input[type="email"], input[name*="email"]'); if(e) e.value = DATA_PEMBELI.email;
    const h = document.querySelector('input[type="tel"], input[name*="phone"]'); if(h) h.value = DATA_PEMBELI.nomor_hp;
    const k = document.querySelector('input[name*="identity"], input[name*="ktp"]'); if(k) k.value = DATA_PEMBELI.nomor_ktp;
    
    const tnc = document.querySelector('input[type="checkbox"]'); if(tnc && !tnc.checked) tnc.click();
    console.log("✅ Data diri berhasil diisi! Silakan segera klik BAYAR secara manual.");
}, 1500);