import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { BlogPostStatus } from '@prisma/client';

// DTO untuk Artikel (Post)
export class CreatePostDto {
    @IsString()
    @IsNotEmpty()
    title: string;

    @IsString()
    @IsNotEmpty()
    slug: string;

    @IsString()
    @IsNotEmpty()
    contentHtml: string;

    @IsString()
    @IsOptional()
    thumbnailUrl?: string;

    @IsNotEmpty()
    categoryId: number; // ID Kategori

    @IsEnum(BlogPostStatus) // 'draft', 'published', 'archived'
    @IsOptional()
    status?: BlogPostStatus;

    // SEO Fields (Opsional)
    @IsString() @IsOptional() metaTitle?: string;
    @IsString() @IsOptional() metaDescription?: string;
    @IsString() @IsOptional() metaKeywords?: string;
}

// DTO untuk Kategori Blog
export class CreateCategoryDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsString()
    @IsNotEmpty()
    slug: string;
}