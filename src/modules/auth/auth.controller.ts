import { Controller, Post, Body, Get, UseGuards, Request, BadRequestException } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AuthGuard } from './auth.guard'; 
import { Throttle } from '@nestjs/throttler';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Throttle({ short: { limit: 3, ttl: 60000 } })
  @Post('register')
  register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Throttle({ short: { limit: 3, ttl: 60000 } })
  @Post('login')
  login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @Throttle({ short: { limit: 3, ttl: 60000 } })
  @Post('google')
  async googleLogin(@Body('token') token: string) {
    if (!token) throw new BadRequestException('Token Google wajib diisi.');
    return this.authService.loginWithGoogle(token);
  }

  //BUTUH APPLE DEVELOPER BUTUH DEVICE IOS
  // @Throttle({ short: { limit: 3, ttl: 60000 } })
  // @Post('apple')
  // async appleLogin(
  //   @Body('token') token: string,
  //   @Body('name') name?: string
  // ) {
  //   return this.authService.loginWithApple(token, name);
  // }

  @Throttle({ short: { limit: 10, ttl: 60000 } })
  @Get('me')
  @UseGuards(AuthGuard) 
  getProfile(@Request() req) {
    return this.authService.getProfile(req.user.sub);
  }
}