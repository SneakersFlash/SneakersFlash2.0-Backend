import {
    CanActivate,
    ExecutionContext,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

@Injectable()
export class AuthGuard implements CanActivate {
    constructor(
        private jwtService: JwtService,
        // ConfigService dihapus — secret sudah dikonfigurasi di JwtModule.registerAsync()
        // sehingga jwtService.verifyAsync() otomatis menggunakan secret yang benar
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const request = context.switchToHttp().getRequest();
        const token = this.extractTokenFromHeader(request);

        if (!token) {
            throw new UnauthorizedException('Token tidak ditemukan, silakan login.');
        }

        try {
            // Tidak perlu passing secret manual — sudah dihandle oleh JwtModule.registerAsync()
            const payload = await this.jwtService.verifyAsync(token);

            // Tempelkan data user (payload) ke request object
            // Bisa diakses di Controller via @Request() req => req.user
            request['user'] = payload;
        } catch {
            throw new UnauthorizedException('Token tidak valid atau kadaluarsa.');
        }
        return true;
    }

    // Helper untuk mengambil token dari header "Authorization: Bearer <token>"
    private extractTokenFromHeader(request: Request): string | undefined {
        const [type, token] = request.headers.authorization?.split(' ') ?? [];
        return type === 'Bearer' ? token : undefined;
    }
}