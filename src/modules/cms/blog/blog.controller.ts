import { Body, Controller, Get, Param, Post, Query, Request, UseGuards } from '@nestjs/common';
import { BlogService } from './blog.service';
import { CreateCategoryDto, CreatePostDto } from './dto/create-blog.dto';
import { AuthGuard } from 'src/modules/auth/auth.guard';
import { RolesGuard } from 'src/common/guards/roles.guard';
import { Roles } from 'src/common/decorators/roles.decorator';
import { Role } from '@prisma/client';

@Controller('blog')
export class BlogController {
  constructor(private readonly blogService: BlogService) { }

  // --- PUBLIC (Untuk User Baca Berita) ---

  @Get('posts')
  findAll(
    @Query('page') page: number,
    @Query('category') category: string
  ) {
    return this.blogService.findAllPublished(Number(page) || 1, 6, category);
  }

  @Get('posts/:slug')
  findOne(@Param('slug') slug: string) {
    return this.blogService.findBySlug(slug);
  }

  @Get('categories')
  getCategories() {
    return this.blogService.getCategories();
  }

  // --- ADMIN (Untuk Tulis Berita) ---

  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  @Post('categories')
  createCategory(@Body() dto: CreateCategoryDto) {
    return this.blogService.createCategory(dto);
  }

  @UseGuards(AuthGuard, RolesGuard)
  @Roles(Role.admin)
  @Post('posts')
  createPost(@Request() req, @Body() dto: CreatePostDto) {
    const userId = req.user.userId || req.user.id;
    return this.blogService.createPost(Number(userId), dto);
  }
}