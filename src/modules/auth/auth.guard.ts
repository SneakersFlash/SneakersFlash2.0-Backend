import {
    CanActivate,
    ExecutionContext,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

@Injectable()
export class AuthGuard implements CanActivate {
    constructor(
        private jwtService: JwtService,
        private configService: ConfigService // Untuk ambil JWT_SECRET dari .env
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest();
        const token = this.extractTokenFromHeader(request);

        if (!token) {
        throw new UnauthorizedException('Token tidak ditemukan, silakan login.');
        }

        try {
        // Verifikasi token menggunakan Secret Key dari .env
        const payload = await this.jwtService.verifyAsync(token, {
            secret: this.configService.get<string>('JWT_SECRET'),
        });
        
        // 💡 PENTING: Kita tempelkan data user (payload) ke request object
        // Jadi di Controller nanti bisa diakses via @Request() req
        request['user'] = payload;
        } catch {
        throw new UnauthorizedException('Token tidak valid atau kadaluarsa.');
        }
        return true;
    }

    // Fungsi helper untuk mengambil token setelah kata "Bearer "
    private extractTokenFromHeader(request: Request): string | undefined {
        const [type, token] = request.headers.authorization?.split(' ') ?? [];
        return type === 'Bearer' ? token : undefined;
    }
}