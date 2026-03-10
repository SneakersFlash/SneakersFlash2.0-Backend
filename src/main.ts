import { NestFactory, Reflector } from '@nestjs/core';
import { AppModule } from './app.module';
import { ClassSerializerInterceptor, ValidationPipe } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  SwaggerDocumentOptions,
} from '@nestjs/swagger';
import helmet from 'helmet';

async function bootstrap() {
  (BigInt.prototype as any).toJSON = function () {
    return this.toString();
  };

  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });

  // ─── Security ────────────────────────────────────────────────────────────────
  app.use(
    helmet({
      crossOriginResourcePolicy: false,
      // Allow Swagger UI to load assets properly
      contentSecurityPolicy:
        process.env.NODE_ENV === 'production' ? undefined : false,
    }),
  );

  // ─── Global Pipes & Interceptors ─────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Auto-exclude fields marked with @Exclude() from class-transformer
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));

  // ─── CORS ────────────────────────────────────────────────────────────────────
  app.enableCors({
    origin: [
      'http://localhost:3001',
      'http://localhost:3002',
      'http://76.13.18.19:8080',
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    credentials: true,
  });

  // ─── Swagger ─────────────────────────────────────────────────────────────────
  if (process.env.NODE_ENV !== 'production') {
    const config = new DocumentBuilder()
      .setTitle('SneakersFlash API')
      .setDescription(
        `
## SneakersFlash 2.0 REST API

Dokumentasi lengkap semua endpoint yang tersedia.

### Autentikasi
Gunakan tombol **Authorize 🔒** dan masukkan token JWT dengan format:
\`Bearer <token>\`

### Konvensi Response
- \`200\` – Sukses
- \`201\` – Resource berhasil dibuat
- \`400\` – Request tidak valid
- \`401\` – Tidak terautentikasi
- \`403\` – Tidak punya akses
- \`404\` – Resource tidak ditemukan
- \`409\` – Konflik data (contoh: email duplikat)
- \`500\` – Internal server error
      `.trim(),
      )
      .setVersion('2.0')
      .setContact(
        'SneakersFlash Team',
        'https://sneakersflash.com',
        'dev@sneakersflash.com',
      )
      .setLicense('Private', 'https://sneakersflash.com')
      .addServer('http://localhost:3000', 'Local Development')
      .addServer('https://api.sneakersflash.com', 'Production')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Masukkan JWT token kamu di sini',
        },
        'access-token', // ← nama ini dipakai di @ApiBearerAuth('access-token')
      )
      .addTag('Auth', 'Login, register, refresh token')
      .addTag('Users', 'Manajemen user & profil')
      .addTag('Products', 'Katalog produk sneakers')
      .addTag('Orders', 'Pemesanan & transaksi')
      .addTag('Webhooks', 'Endpoint webhook eksternal (Ginee, dll)')
      .build();

    const options: SwaggerDocumentOptions = {
      // Otomatis kelompokkan operasi berdasarkan tag pertama
      operationIdFactory: (controllerKey, methodKey) =>
        `${controllerKey}_${methodKey}`,
      deepScanRoutes: true,
    };

    const document = SwaggerModule.createDocument(app, config, options);

    SwaggerModule.setup('api/docs', app, document, {
      customSiteTitle: 'SneakersFlash API Docs',
      customfavIcon: 'https://sneakersflash.com/favicon.ico',
      swaggerOptions: {
        persistAuthorization: true,   // Token tidak hilang saat refresh halaman
        displayRequestDuration: true, // Tampilkan durasi request
        filter: true,                 // Aktifkan search/filter endpoint
        showExtensions: true,
        docExpansion: 'none',         // Semua section collapsed by default
        tagsSorter: 'alpha',          // Urutkan tag A-Z
        operationsSorter: 'alpha',    // Urutkan operasi A-Z
        tryItOutEnabled: false,       // Nonaktifkan "Try it out" by default
      },
    });

    console.log(
      `📚 Swagger docs tersedia di: http://localhost:${process.env.PORT ?? 3000}/api/docs`,
    );
  }

  await app.listen(process.env.PORT ?? 3000);
  console.log(`🚀 App berjalan di port ${process.env.PORT ?? 3000}`);
}
bootstrap();