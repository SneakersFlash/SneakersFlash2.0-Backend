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

  // 5. Hitung Ongkir (Dinamis + Support COD, Item Value, & Instant/Sameday)
  async calculateShippingCost(
    destinationSubdistrictId: number,
    weight: number,               // Frontend mengirim 1.6 (Kilogram)
    courier: string = '',
    itemValue: number = 560000,   // Default value atau ambil dari request
    isCod: boolean = false,
    originPinPoint?: string,      
    destinationPinPoint?: string, 
  ) {
    let baseUrl = process.env.KOMERCE_BASE_URL || 'https://api-sandbox.collaborator.komerce.id';
    baseUrl = baseUrl.replace(/\/$/, '');

    const endpoint = `${baseUrl}/tariff/api/v1/calculate`;

    try {
      const params: any = {
        shipper_destination_id: this.originSubdistrictId,
        receiver_destination_id: String(destinationSubdistrictId),
        weight: String(weight),         // Mengirim "1.6"
        item_value: String(itemValue),  // Mengirim "560000"
        cod: isCod ? 'yes' : 'no'       // 👈 Komerce butuh "yes" / "no", bukan true/false
      };

      // Hapus spasi agar axios encode menjadi %2C (bukan %2C%20)
      if (originPinPoint) {
        params.origin_pin_point = originPinPoint.replace(/\s+/g, '');
      }
      if (destinationPinPoint) {
        params.destination_pin_point = destinationPinPoint.replace(/\s+/g, '');
      }

      this.logger.log('Tembak Komerce API Calculate Params:', params);

      const response = await axios.get(endpoint, {
        params: params,
        headers: {
          'x-api-key': process.env.KOMERCE_API_KEY || process.env.RAJAONGKIR_API_KEY,
          'Accept': 'application/json'
        }
      });

      const result = response.data;

      this.logger.log(result)

      const listReguler = result.data?.calculate_reguler || [];
      const listCargo = result.data?.calculate_cargo || [];
      const listInstant = result.data?.calculate_instant || []; 
      
      // ==============================================================
      // CUSTOM FILTER: HANYA JNE & INSTANT/SAMEDAY
      // ==============================================================
      
      // 1. Saring Reguler & Cargo agar HANYA memunculkan JNE
      const jneOptions = [...listReguler, ...listCargo].filter(
        (opt: any) => (opt.shipping_name || '').toUpperCase() === 'JNE'
      );

      // 2. Gabungkan hasil saringan JNE dengan semua opsi Instant/SameDay
      const allOptions = [...jneOptions, ...listInstant];
      
      let shippingOptions: any = [];

      if (allOptions.length > 0) {
        const filteredData = courier 
          ? allOptions.filter((opt: any) => (opt.shipping_name || '').toLowerCase().includes(courier.toLowerCase()))
          : allOptions;

        shippingOptions = filteredData.map((opt: any) => ({
          courier: opt.shipping_name,
          courier_name: opt.shipping_name,
          service: opt.service_name,
          description: `Layanan ${opt.service_name}`,
          cost: Number(opt.shipping_cost || 0),
          etd: opt.etd || 'Standard', 
          cashback: Number(opt.shipping_cashback || 0),
          is_cod_available: false
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

    const dateOb = new Date();
    dateOb.setHours(dateOb.getHours() + 7);
    const orderDate = dateOb.toISOString().slice(0, 19).replace('T', ' ');

    const shippingType = order.courierService || 'REG';

    // 👇 AMBIL SUBTOTAL DARI ORDER DB
    const subtotal = Number(order.subtotal);
    const shippingCost = Number(order.shippingCost);
    const discount = Number(order.discountTotal || 0);
    const finalAmount = Number(order.finalAmount);

    const payload: any = {
      order_date: orderDate,
      brand_name: process.env.STORE_BRAND_NAME || 'SneakersFlash',

      // Data Pengirim
      shipper_name: process.env.STORE_SHIPPER_NAME || 'Sneakers Flash',
      shipper_phone: process.env.STORE_SHIPPER_PHONE || '081234567890',
      shipper_destination_id: Number(process.env.STORE_ORIGIN_SUBDISTRICT_ID) || 17485,
      shipper_address: process.env.STORE_ADDRESS || 'Jl. Gudang Utama No 1',
      shipper_email: process.env.STORE_EMAIL || 'sneakersflash23@gmail.com',

      // Data Penerima
      receiver_name: order.shippingRecipientName,
      receiver_phone: order.shippingPhone,
      receiver_destination_id: Number(order.shippingSubdistrictId),
      receiver_address: `${order.shippingAddressLine} (Kec. ${order.shippingDistrict}, ${order.shippingCity})`,

      // Data Logistik
      shipping: order.courierName.toUpperCase(),
      shipping_type: shippingType,
      payment_method: 'BANK TRANSFER',

      // 💰 PERBAIKAN MATEMATIKA (ITEM VALUE WAJIB ADA) 💰
      item_value: subtotal,
      shipping_cost: shippingCost,
      discount: 0,
      grand_total: subtotal + shippingCost,

      shipping_cashback: Number(order.shippingCashback || 0),
      service_fee: 0,
      additional_cost: 0,
      cod_value: 0,
      insurance_value: 0,

      // Detail Barang
      order_details: order.orderItems.map((item: any) => ({
        product_name: item.productName,
        product_variant_name: item.variantName ? item.variantName : '-',
        product_price: Number(item.price),
        product_width: 5,
        product_height: 5,
        product_length: 5,
        product_weight: Math.ceil((order.totalWeightGrams || 1000) / order.orderItems.length),
        qty: item.quantity,
        subtotal: Number(item.subtotal)
      }))
    };

    if (order.shippingLatitude && order.shippingLongitude) {
      const originLat = process.env.STORE_LATITUDE || '-6.1752685';
      const originLng = process.env.STORE_LONGITUDE || '106.7720772';
      
      payload.origin_pin_point = `${originLat},${originLng}`;
      payload.destination_pin_point = `${order.shippingLatitude},${order.shippingLongitude}`;
    }

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

  // 7. Request Print Label (Komerce)
  async getShippingLabel(orderNo: string, pageSize: string = 'page_5') {
    let baseUrl = process.env.KOMERCE_BASE_URL || 'https://api-sandbox.collaborator.komerce.id';
    // Bersihkan trailing slash agar penggabungan URL rapi
    baseUrl = baseUrl.replace(/\/api\/v1\/?$/, '').replace(/\/$/, '');

    const endpoint = `${baseUrl}/order/api/v1/orders/print-label?page=${pageSize}&order_no=${orderNo}`;

    this.logger.log(`Tembak Komerce API Label: ${endpoint}`);

    try {
      const response = await axios.post(endpoint, {}, {
        headers: {
          'x-api-key': process.env.KOMERCE_API_KEY || process.env.RAJAONGKIR_API_KEY,
          'Accept': 'application/json' 
        }
      });

      const labelData = response.data?.data;
      if (!labelData) {
          throw new Error('Data label kosong atau format tidak sesuai dari Komerce');
      }

      // ==============================================================
      // PERBAIKAN: FORMAT RELATIVE URL MENJADI ABSOLUTE URL
      // ==============================================================
      let finalPdfUrl = labelData.path;
      if (finalPdfUrl && !finalPdfUrl.startsWith('http')) {
        // Gabungkan Base URL Komerce dengan path dari response
        // .replace(/^\//, '') berfungsi menghapus garis miring ganda di awal path jika ada
        finalPdfUrl = `${baseUrl}/${finalPdfUrl.replace(/^\//, '')}`;
      }

      this.logger.log(`Berhasil mendapatkan label untuk OrderNo: ${orderNo} -> ${finalPdfUrl}`);
      
      return {
          pdf_url: finalPdfUrl, // Gunakan URL yang sudah diformat
          base64: labelData.base_64,
          message: 'Berhasil generate label pengiriman'
      };

    } catch (error: any) {
      const errorMessage = error.response?.data?.meta?.message || error.message;
      this.logger.error(`Gagal mendapatkan Label Komerce: ${errorMessage}`);
      
      throw new InternalServerErrorException(
        errorMessage || 'Gagal mengunduh label pengiriman Komerce'
      );
    }
  }

  async trackShipment(awb: string, courier: string, lastPhoneNumber?: string) {
    const endpoint = `${this.baseUrl}/track/waybill`;
 
    // last_phone_number: 5 digit terakhir nomor HP penerima — wajib untuk JNE
    const isJne = courier.toLowerCase() === 'jne';
    if (isJne && !lastPhoneNumber) {
      throw new BadRequestException(
        'Parameter last_phone_number (5 digit terakhir nomor penerima) wajib diisi untuk kurir JNE'
      );
    }
 
    const params: Record<string, string> = {
      awb,
      courier: courier.toLowerCase(),
    };
 
    if (lastPhoneNumber) {
      // Ambil 5 digit terakhir, buang karakter non-digit terlebih dahulu
      params.last_phone_number = lastPhoneNumber.replace(/\D/g, '').slice(-5);
    }
 
    this.logger.log(`Tracking AWB: ${awb}, Kurir: ${courier}`);
 
    try {
      const response = await axios.post(endpoint, null, {
        params,
        headers: this.headers, // Gunakan header 'key' standar RajaOngkir
      });
 
      const data = response.data?.data;
      if (!data) {
        throw new InternalServerErrorException('Data tracking kosong dari RajaOngkir');
      }
 
      return {
        delivered: data.delivered ?? false,
        summary: {
          courier_code:     data.summary?.courier_code,
          courier_name:     data.summary?.courier_name,
          waybill_number:   data.summary?.waybill_number,
          service_code:     data.summary?.service_code,
          waybill_date:     data.summary?.waybill_date,
          shipper_name:     data.summary?.shipper_name,
          receiver_name:    data.summary?.receiver_name,
          origin:           data.summary?.origin,
          destination:      data.summary?.destination,
          status:           data.summary?.status,
        },
        details: data.details ?? null,
        delivery_status: {
          status:       data.delivery_status?.status,
          pod_receiver: data.delivery_status?.pod_receiver,
          pod_date:     data.delivery_status?.pod_date,
          pod_time:     data.delivery_status?.pod_time,
        },
        // Manifest diurutkan terbaru di atas agar mudah dibaca frontend
        manifest: (data.manifest ?? []).sort((a: any, b: any) => {
          const dateA = new Date(`${a.manifest_date} ${a.manifest_time}`).getTime();
          const dateB = new Date(`${b.manifest_date} ${b.manifest_time}`).getTime();
          return dateB - dateA;
        }),
      };
    } catch (error: any) {
      if (error instanceof BadRequestException) throw error;
 
      const apiMessage = error.response?.data?.meta?.message;
      const statusCode = error.response?.status;

      if (statusCode === 404) {
        throw new BadRequestException(`Resi ${awb} tidak ditemukan di kurir ${courier}`);
      }

      this.logger.error(`Gagal tracking AWB ${awb}:`, apiMessage || error.message);
      throw new InternalServerErrorException(
        apiMessage || 'Gagal melakukan tracking pengiriman'
      );
    }
  }
}