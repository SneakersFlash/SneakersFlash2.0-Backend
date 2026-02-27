// ginee-log.service.ts
import { Injectable } from '@nestjs/common';
import { GineeLogStatus, GineeLogType } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class GineeLogService {
  constructor(private prisma: PrismaService) {}

  async getLogs(params: {
    page?: number;
    limit?: number;
    type?: GineeLogType;
    status?: GineeLogStatus;
  }) {
    const { page = 1, limit = 10, type, status } = params;
    const skip = (page - 1) * limit;

    const [data, total] = await Promise.all([
      this.prisma.gineeSyncLog.findMany({
        where: {
          type: type || undefined,
          status: status || undefined,
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.gineeSyncLog.count({
        where: {
          type: type || undefined,
          status: status || undefined,
        },
      }),
    ]);

    return {
      data,
      meta: {
        total,
        page,
        lastPage: Math.ceil(total / limit),
      },
    };
  }
}