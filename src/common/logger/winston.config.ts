// src/common/logger/winston.config.ts
// Production Logger: Winston dengan format aman (tanpa secrets)
import { WinstonModule } from 'nest-winston';
import * as winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import { utilities as nestWinstonModuleUtilities } from 'nest-winston';

// Daftar field yang harus di-mask sebelum di-log
const SENSITIVE_FIELDS = [
  'password',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'authorization',
  'credit_card',
  'card_number',
  'cvv',
  'server_key',
  'apiKey',
  'api_key',
  'secret',
  'MIDTRANS_SERVER_KEY',
  'CLOUDINARY_API_SECRET',
  'JWT_SECRET',
];

// Custom format untuk mask data sensitif
const maskSensitiveData = winston.format((info) => {
  const masked = { ...info };

  // Recursively mask sensitive fields dalam object
  function maskObject(obj: Record<string, unknown>): Record<string, unknown> {
    if (!obj || typeof obj !== 'object') return obj;

    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      if (SENSITIVE_FIELDS.some((field) => lowerKey.includes(field.toLowerCase()))) {
        result[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        result[key] = maskObject(value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  // Mask di message string jika mengandung pattern
    if (typeof masked.message === 'string') {
        masked.message = (masked.message as string)
        .replace(/Bearer\s[^\s]*/g, 'Bearer [REDACTED]')
        .replace(/Basic\s[^\s]*/g, 'Basic [REDACTED]')
        .replace(/Mid-server-[^\s"']*/g, 'Mid-server-[REDACTED]')
        .replace(/:\/\/[^:]+:[^@]+@/g, '://[REDACTED]@');
    }

  return maskObject(masked as Record<string, unknown>) as winston.Logform.TransformableInfo;
})();

// Format untuk file log (JSON)
const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  maskSensitiveData,
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

// Format untuk console (human-readable)
const consoleFormat = winston.format.combine(
  winston.format.timestamp(),
  maskSensitiveData,
  nestWinstonModuleUtilities.format.nestLike('SneakersFlash', {
    prettyPrint: true,
  }),
);

// Daily rotate file transport
const createFileTransport = (filename: string, level: string) =>
  new DailyRotateFile({
    filename: `${process.env.LOG_DIR || 'logs'}/${filename}-%DATE%.log`,
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '30d',
    level,
    format: fileFormat,
  });

export const winstonConfig = WinstonModule.createLogger({
  level: process.env.LOG_LEVEL || 'warn',
  transports: [
    // Console (hanya di development)
    ...(process.env.NODE_ENV !== 'production'
      ? [new winston.transports.Console({ format: consoleFormat })]
      : []),

    // Error log
    createFileTransport('error', 'error'),

    // Combined log
    createFileTransport('combined', 'info'),

    // Payment log (terpisah untuk audit)
    new DailyRotateFile({
      filename: `${process.env.LOG_DIR || 'logs'}/payment-%DATE%.log`,
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '50m',
      maxFiles: '90d', // Simpan 90 hari untuk audit trail
      level: 'info',
      format: fileFormat,
      // Hanya log yang berkaitan dengan payment
    }),
  ],

  // Exception handling
  exceptionHandlers: [
    createFileTransport('exceptions', 'error'),
  ],

  // Rejection handling
  rejectionHandlers: [
    createFileTransport('rejections', 'error'),
  ],
});
