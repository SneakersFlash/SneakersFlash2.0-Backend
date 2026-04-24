import { NestFactory, Reflector } from '@nestjs/core';
import { AppModule } from './app.module';
import {
  ClassSerializerInterceptor,
  ValidationPipe,
  Logger,
} from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  SwaggerDocumentOptions,
} from '@nestjs/swagger';
import helmet from 'helmet';
import compression from 'compression';
import { NestExpressApplication } from '@nestjs/platform-express';
import { ConfigService } from '@nestjs/config';

async function bootstrap() {
  // ─── BigInt JSON patch (existing) ───────────────────────────────────────────
  (BigInt.prototype as any).toJSON = function () {
    return this.toString();
  };

  const logger = new Logger('Bootstrap');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true, // wajib untuk Midtrans webhook signature validation
    logger:
      process.env.NODE_ENV === 'production'
        ? ['error', 'warn']
        : ['log', 'debug', 'error', 'warn', 'verbose'],
    abortOnError: false,
  });

  const configService = app.get(ConfigService);
  const nodeEnv = configService.get<string>('NODE_ENV', 'development');
  const port = configService.get<number>('PORT', 3000);
  const frontendUrl = configService.get<string>('FRONTEND_URL', '');
  const allowedOriginsEnv = configService.get<string>(
    'ALLOWED_ORIGINS',
    frontendUrl,
  );

  // Gabungkan origins dari env + hardcoded dev origins
  const productionOrigins = allowedOriginsEnv
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  const devOrigins =
    nodeEnv !== 'production'
      ? [
          'http://localhost:3001',
          'http://localhost:3002',
          'http://76.13.18.19:8080',
          'https://sneakers-flash2-0-store.vercel.app',
          'https://soledad-unsoothing-bud.ngrok-free.dev',
          'https://sneakers-flash2-0-stag.vercel.app',
          'https://sneakers-flash2-0-admin.vercel.app',
        ]
      : [];

  const allowedOrigins = [...new Set([...productionOrigins, ...devOrigins])];

  // ─── 1. TRUST PROXY (di belakang Nginx) ────────────────────────────────────
  app.set('trust proxy', 1);

  // ─── 2. HELMET — Security Headers ──────────────────────────────────────────
  app.use(
    helmet({
      // Di production: CSP ketat. Di development: nonaktifkan agar Swagger jalan
      contentSecurityPolicy:
        nodeEnv === 'production'
          ? {
              directives: {
                defaultSrc: ["'none'"],
                scriptSrc: ["'none'"],
                styleSrc: ["'none'"],
                imgSrc: ["'none'"],
                connectSrc: ["'none'"],
                fontSrc: ["'none'"],
                objectSrc: ["'none'"],
                mediaSrc: ["'none'"],
                frameSrc: ["'none'"],
                frameAncestors: ["'none'"],
              },
            }
          : false, // nonaktifkan agar Swagger UI bisa load
      // Cross-Origin Resource Policy: false agar asset Swagger bisa diakses
      crossOriginResourcePolicy:
        nodeEnv === 'production' ? { policy: 'same-origin' } : false,
      frameguard: { action: 'deny' },
      noSniff: true,
      xssFilter: true,
      hsts:
        nodeEnv === 'production'
          ? { maxAge: 31536000, includeSubDomains: true, preload: true }
          : false,
      hidePoweredBy: true,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );

  // ─── 3. CORS — Strict Origin ────────────────────────────────────────────────
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true); // server-to-server & mobile app
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        if (nodeEnv === 'production') {
          logger.warn(`CORS blocked origin: ${origin}`);
        }
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-ID',
      'X-Correlation-ID',
    ],
    exposedHeaders: [
      'X-Request-ID',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
    ],
    credentials: true,
    maxAge: 86400,
  });

  // ─── 4. COMPRESSION ─────────────────────────────────────────────────────────
  app.use(compression());

  // ─── 5. GLOBAL VALIDATION PIPE ──────────────────────────────────────────────
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // Di production sembunyikan detail error (anti information disclosure)
      disableErrorMessages: nodeEnv === 'production',
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // ─── 6. CLASS SERIALIZER (existing — @Exclude() support) ────────────────────
  app.useGlobalInterceptors(new ClassSerializerInterceptor(app.get(Reflector)));

  // ─── 7. GLOBAL PREFIX ───────────────────────────────────────────────────────
  // HAPUS ini jika Anda belum pakai prefix di route yang ada,
  // atau sesuaikan dengan konfigurasi existing Anda
  // app.setGlobalPrefix('api/v1');

  // ─── 8. SWAGGER (hanya development) ─────────────────────────────────────────
  if (nodeEnv !== 'production') {
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
      .addServer(`http://localhost:${port}`, 'Local Development')
      .addServer('https://api.sneakersflash.com', 'Production')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Masukkan JWT token kamu di sini',
        },
        'access-token',
      )
      .addTag('Auth', 'Login, register, refresh token')
      .addTag('Users', 'Manajemen user & profil')
      .addTag('Products', 'Katalog produk sneakers')
      .addTag('Orders', 'Pemesanan & transaksi')
      .addTag('Webhooks', 'Endpoint webhook eksternal (Ginee, dll)')
      .build();

    const options: SwaggerDocumentOptions = {
      operationIdFactory: (controllerKey, methodKey) =>
        `${controllerKey}_${methodKey}`,
      deepScanRoutes: true,
    };

    const document = SwaggerModule.createDocument(app, config, options);
    SwaggerModule.setup('api/docs', app, document, {
      customSiteTitle: 'SneakersFlash API Docs',
      customfavIcon: 'https://sneakersflash.com/favicon.ico',
      swaggerOptions: {
        persistAuthorization: true,
        displayRequestDuration: true,
        filter: true,
        showExtensions: true,
        docExpansion: 'none',
        tagsSorter: 'alpha',
        operationsSorter: 'alpha',
        tryItOutEnabled: false,
      },
    });

    logger.log(`📚 Swagger: http://localhost:${port}/api/docs`);
  }

  // ─── 9. GRACEFUL SHUTDOWN ───────────────────────────────────────────────────
  app.enableShutdownHooks();

  // ─── 10. START ──────────────────────────────────────────────────────────────
  await app.listen(port, '0.0.0.0');
  logger.log(`🚀 App berjalan di port ${port} [${nodeEnv}]`);
  logger.log(`Allowed origins: ${allowedOrigins.join(', ')}`);
}

bootstrap().catch((err) => {
  console.error('Failed to start application:', err);
  process.exit(1);
});