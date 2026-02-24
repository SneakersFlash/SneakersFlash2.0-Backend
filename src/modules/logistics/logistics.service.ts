import { Injectable, InternalServerErrorException, BadRequestException, Logger } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class LogisticsService {
  private readonly logger = new Logger(LogisticsService.name);

  // Konfigurasi sesuai services.php
  private readonly baseUrl = process.env.RAJAONGKIR_BASE_URL || 'https://rajaongkir.komerce.id/api/v1';
  private readonly apiKey = process.env.RAJAONGKIR_API_KEY || process.env.KOMERCE_API_KEY;

  // ID Kecamatan Gudang (Default Duri Kepa jika tidak ada di env)
  private readonly originSubdistrictId = process.env.STORE_ORIGIN_DESTINATION_ID || '17485';

  private get headers() {
    return {
      'key': this.apiKey, // PHP menggunakan header 'key', bukan Authorization
      'Accept': 'application/json',
      // 'Content-Type': 'application/json',
    };
  }

  // 1. Ambil Provinsi
  async getProvinces() {
    try {
      const response = await axios.get(`${this.baseUrl}/destination/province`, { headers: this.headers });
      return response.data?.data?.map(p => ({ id: p.id, name: p.name })) || [];
    } catch (error: any) {
      this.logger.error('Gagal mengambil provinsi', error.response?.data);
      throw new InternalServerErrorException('Gagal mengambil data provinsi');
    }
  }

  // 2. Ambil Kota (Hierarki: butuh provinceId)
  async getCities(provinceId: number) {
    try {
      const response = await axios.get(`${this.baseUrl}/destination/city/${provinceId}`, { headers: this.headers });
      return response.data?.data?.map(c => ({
        id: c.id,
        name: c.name,
        postal_code: c.zip_code
      })) || [];
    } catch (error: any) {
      this.logger.error(`Gagal kota prov ${provinceId}`, error.response?.data);
      throw new InternalServerErrorException('Gagal mengambil data kota');
    }
  }

  // 3. Ambil Kecamatan/District (Hierarki: butuh cityId)
  async getDistricts(cityId: number) {
    try {
      const response = await axios.get(`${this.baseUrl}/destination/district/${cityId}`, { headers: this.headers });
      return response.data?.data?.map(d => ({ id: d.id, name: d.name })) || [];
    } catch (error: any) {
      this.logger.error(`Gagal district city ${cityId}`, error.response?.data);
      throw new InternalServerErrorException('Gagal mengambil data kecamatan');
    }
  }

  // 4. Ambil Kelurahan/Sub-District (Tujuan Akhir Pengiriman)
  async getSubDistricts(districtId: number) {
    try {
      const response = await axios.get(`${this.baseUrl}/destination/sub-district/${districtId}`, { headers: this.headers });
      return response.data?.data?.map(sd => ({
        id: sd.id,
        name: sd.name,
        zip_code: sd.zip_code
      })) || [];
    } catch (error: any) {
      this.logger.error(`Gagal subdistrict ${districtId}`, error.response?.data);
      throw new InternalServerErrorException('Gagal mengambil data kelurahan');
    }
  }

  // 5. Hitung Ongkir (Dinamis menggunakan API Komerce/Komship Calculate)
  // 5. Hitung Ongkir (Dinamis + Support COD & Item Value)
  async calculateShippingCost(
    destinationSubdistrictId: number,
    weightGrams: number,
    courier: string = 'jne',
    // TAMBAHAN: Parameter opsional untuk data dinamis
    extraOptions?: { itemValue?: number; isCod?: boolean }
  ) {
    let baseUrl = process.env.KOMERCE_BASE_URL || 'https://api-sandbox.collaborator.komerce.id';
    baseUrl = baseUrl.replace(/\/$/, '');

    const endpoint = `${baseUrl}/tariff/api/v1/calculate`;
    const finalWeight = Math.max(1000, weightGrams);

    // LOGIC DINAMIS:
    // 1. Cek apakah user mau COD? Konversi boolean ke string 'yes'/'no'
    const codStatus = extraOptions?.isCod ? 'yes' : 'no';

    // 2. Cek harga barang (penting untuk asuransi/COD). Default 100k jika kosong.
    const productValue = extraOptions?.itemValue || 100000;

    try {
      this.logger.log(`Cek Ongkir: Tujuan ${destinationSubdistrictId}, Berat ${finalWeight}g, COD: ${codStatus}, Value: ${productValue}`);

      const params = {
        shipper_destination_id: this.originSubdistrictId,
        receiver_destination_id: destinationSubdistrictId,
        weight: finalWeight,
        item_value: productValue, // <-- Nilai Dinamis
        cod: codStatus            // <-- Nilai Dinamis
      };

      const response = await axios.get(endpoint, {
        params: params,
        headers: {
          'x-api-key': process.env.KOMERCE_API_KEY || process.env.RAJAONGKIR_API_KEY,
          'Accept': 'application/json'
        }
      });

      const result = response.data;

      const listReguler = result.data?.calculate_reguler || [];
      const listCargo = result.data?.calculate_cargo || [];
      const allOptions = [...listReguler, ...listCargo];

      let shippingOptions: any = [];

      if (allOptions.length > 0) {
        const filteredData = allOptions.filter((opt: any) => {
          const name = opt.shipping_name || '';
          return name.toLowerCase().includes(courier.toLowerCase());
        });

        shippingOptions = filteredData.map((opt: any) => ({
          courier: opt.shipping_name,
          courier_name: opt.shipping_name,
          service: opt.service_name,
          description: `Layanan ${opt.service_name}`,
          cost: Number(opt.shipping_cost || 0),
          etd: 'Standard',
          cashback: Number(opt.shipping_cashback || 0),
          // Tambahan info biar frontend tahu ini bisa COD atau tidak
          is_cod_available: opt.is_cod || false
        }));
      }

      return shippingOptions;

    } catch (error: any) {
      this.logger.error('Ongkir Komerce Error:', error.response?.data || error.message);
      return [];
    }
  }

  // Porting Logic Filter dari PHP
  private filterUnwantedServices(options: any[]) {
    const excludedServices = ['CTCSPS', 'JTR<130', 'JTR>130', 'JTR>200'];
    const jtrRegex = /^JTR[<>0-9]+$/;

    return options.filter(opt => {
      const service = opt.service.trim();
      if (excludedServices.includes(service)) return false;
      if (jtrRegex.test(service)) return false;
      return true;
    });
  }

  // 6. Request Pickup Kurir (Auto-Create Order Komerce)
  async createShippingOrder(order: any) {
    let baseUrl = process.env.KOMERCE_BASE_URL || 'https://api-sandbox.collaborator.komerce.id';
    baseUrl = baseUrl.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');

    const endpoint = `${baseUrl}/order/api/v1/orders/store`;

    // Format tanggal "YYYY-MM-DD HH:mm:ss"
    const dateOb = new Date();
    dateOb.setHours(dateOb.getHours() + 7); // Tambah 7 jam untuk UTC ke WIB
    const orderDate = dateOb.toISOString().slice(0, 19).replace('T', ' ');

    // --- PERBAIKAN: Format Order Details Sesuai Standar Komerce Baru ---
    const shippingType = order.courierService || 'REG';

    const payload = {
      order_date: orderDate,
      brand_name: process.env.STORE_BRAND_NAME || 'SneakersFlash', // Sebaiknya masuk ENV

      // Data Pengirim
      shipper_name: process.env.STORE_SHIPPER_NAME || 'Sneakers Flash',
      shipper_phone: process.env.STORE_SHIPPER_PHONE || '081234567890',
      shipper_destination_id: Number(process.env.STORE_ORIGIN_SUBDISTRICT_ID) || 17485,
      shipper_address: process.env.STORE_ADDRESS || 'Jl. Gudang Utama No 1',
      shipper_email: process.env.STORE_EMAIL || 'sneakersflash23@gmail.com',

      // Data Penerima (Ambil dari Order DB)
      receiver_name: order.shippingRecipientName,
      receiver_phone: order.shippingPhone,
      receiver_destination_id: Number(order.shippingSubdistrictId), // Pastikan Number
      receiver_address: `${order.shippingAddressLine} (Kec. ${order.shippingDistrict}, ${order.shippingCity})`, // Lengkapi alamat agar kurir mudah cari

      // Data Logistik
      shipping: order.courierName.toUpperCase(), // JNE, SICEPAT, IDEXPRESS
      shipping_type: shippingType,
      payment_method: 'BANK TRANSFER', // Flag Non-COD

      shipping_cost: Number(order.shippingCost),
      shipping_cashback: 0,
      service_fee: 0,
      additional_cost: 0,

      // Karena Non-COD, grand_total adalah nilai barang + ongkir
      grand_total: Number(order.finalAmount),
      cod_value: 0,
      insurance_value: 0,

      // Detail Barang
      order_details: order.orderItems.map((item: any) => ({
        product_name: item.productName,
        // Komerce butuh variant name string. Jika null, beri strip.
        product_variant_name: item.variantName ? item.variantName : '-',
        product_price: Number(item.price),
        // Estimasi dimensi (Opsional tapi disarankan ada value)
        product_width: 5,
        product_height: 5,
        product_length: 5,
        // Berat per item dalam Gram (Total berat / qty) atau default
        product_weight: Math.ceil((order.totalWeightGrams || 1000) / order.orderItems.length),
        qty: item.quantity,
        subtotal: Number(item.subtotal)
      }))
    };

    this.logger.log(`Tembak Komerce API ke: ${endpoint}`);

    try {
      const response = await axios.post(endpoint, payload, {
        headers: {
          'x-api-key': process.env.KOMERCE_API_KEY || process.env.RAJAONGKIR_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      });

      const resi = response.data.data?.awb || response.data.data?.order_no || response.data.data?.airwaybill || 'Terekam-di-Komerce';
      this.logger.log(`Berhasil Request Kurir! Komerce AWB/OrderNo: ${resi}`);

      return response.data.data;
    } catch (error: any) {
      this.logger.error('Gagal Create Order Komerce:', JSON.stringify(error.response?.data || error.message));
      return null;
    }
  }
}