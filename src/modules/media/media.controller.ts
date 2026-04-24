import { Controller, Post, UploadedFile, UseInterceptors, BadRequestException, UseGuards } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { v2 as cloudinary } from 'cloudinary';
import { CloudinaryStorage } from 'multer-storage-cloudinary';

// --- Import Security ---
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '@prisma/client';

// 1. Konfigurasi Kredensial Cloudinary
// (Idealnya ini diletakkan di CloudinaryProvider/Module, tapi bisa di sini untuk setup cepat)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// 2. Buat Storage Engine khusus Cloudinary
const cloudinaryStorage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    return {
      folder: 'sneakersflash', // Aset akan otomatis masuk ke folder ini di Cloudinary
      public_id: `${file.fieldname}-${uniqueSuffix}`, // Nama file unik
      format: 'webp', // (
    };
  },
});

@Controller('media')
export class MediaController {
  
  @Post('upload')
  // 🔒 SECURITY: Pasang Satpam di sini
  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  @UseInterceptors(FileInterceptor('file', {
    // 3. Gunakan Cloudinary Storage di sini (Menggantikan diskStorage)
    storage: cloudinaryStorage,
    
    // 4. Filter Jenis File
    fileFilter: (req, file, callback) => {
      // Menambahkan 'webp' ke dalam regex berjaga-jaga
      if (!file.mimetype.match(/\/(jpg|jpeg|png|gif|webp)$/)) {
        return callback(new BadRequestException('Hanya boleh upload file gambar!'), false);
      }
      callback(null, true);
    },
    // 5. Batas Ukuran (2MB - sesuai komen awalmu, tapi di code kamu 10MB. Saya biarkan 10MB)
    limits: { fileSize: 10 * 1024 * 1024 }, 
  }))
  // Menggunakan tipe 'any' atau membuat interface khusus karena 
  // response object dari CloudinaryStorage berbeda dengan diskStorage standar
  uploadFile(@UploadedFile() file: any) { 
    if (!file) {
      throw new BadRequestException('File tidak ditemukan');
    }

    // CloudinaryStorage secara otomatis menyematkan URL publik langsung di 'file.path'
    return {
      message: 'Upload ke Cloudinary berhasil',
      url: file.path, 
      filename: file.filename || file.public_id, // Tergantung versi, biasanya public_id
    };
  }
}