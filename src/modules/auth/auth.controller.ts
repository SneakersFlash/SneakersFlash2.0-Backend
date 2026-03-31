import { Controller, Post, Body, Get, UseGuards, Request } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { AuthGuard } from './auth.guard'; 

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Post('login')
  login(@Body() loginDto: LoginDto) {
    return this.authService.login(loginDto);
  }

  @Post('google')
  async googleLogin(@Body('token') token: string) {
    return this.authService.loginWithGoogle(token);
  }

  //BUTUH APPLE DEVELOPER BUTUH DEVICE IOS
  // @Post('apple')
  // async appleLogin(
  //   @Body('token') token: string,
  //   @Body('name') name?: string
  // ) {
  //   return this.authService.loginWithApple(token, name);
  // }

  @Get('me')
  @UseGuards(AuthGuard) 
  getProfile(@Request() req) {
    return this.authService.getProfile(req.user.sub);
  }
}