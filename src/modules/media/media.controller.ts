import { Controller, Post, UploadedFile, UseInterceptors, BadRequestException, UseGuards } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { extname } from 'path';

// --- Import Security ---
import { AuthGuard } from '../auth/auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '@prisma/client';

@Controller('media')
export class MediaController {
  
  @Post('upload')
  // 🔒 SECURITY: Pasang Satpam di sini
  @UseGuards(AuthGuard, RolesGuard) // 1. Cek Token & Cek Role
  @Roles(Role.admin)                // 2. Pastikan Role-nya ADMIN
  @UseInterceptors(FileInterceptor('file', {
    // 1. Konfigurasi Lokasi Simpan
    storage: diskStorage({
      destination: './uploads', 
      filename: (req, file, callback) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
        const ext = extname(file.originalname);
        callback(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
      },
    }),
    // 2. Filter Jenis File (Hanya Gambar)
    fileFilter: (req, file, callback) => {
      if (!file.mimetype.match(/\/(jpg|jpeg|png|gif)$/)) {
        return callback(new BadRequestException('Hanya boleh upload file gambar!'), false);
      }
      callback(null, true);
    },
    // 3. Batas Ukuran (2MB)
    limits: { fileSize: 2 * 1024 * 1024 }, 
  }))
  uploadFile(@UploadedFile() file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('File tidak ditemukan');
    }

    const fileUrl = `https://api-test.sneakersflash.com/uploads/${file.filename}`;
    
    return {
      message: 'Upload berhasil',
      url: fileUrl,
      filename: file.filename
    };
  }
}