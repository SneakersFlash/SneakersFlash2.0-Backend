import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreatePostDto, CreateCategoryDto } from './dto/create-blog.dto';

@Injectable()
export class BlogService {
  constructor(private prisma: PrismaService) { }

  // ============================
  // 📁 KATEGORI (Admin Only)
  // ============================
  async createCategory(dto: CreateCategoryDto) {
    return this.prisma.blogCategory.create({ data: dto });
  }

  async getCategories() {
    // Return kategori + jumlah artikel di dalamnya
    const cats = await this.prisma.blogCategory.findMany({
      include: { _count: { select: { posts: true } } }
    });
    return cats.map(c => ({
      ...c,
      id: c.id.toString(),
      postCount: c._count.posts
    }));
  }

  // ============================
  // 📝 ARTIKEL (Admin)
  // ============================
  async createPost(authorId: number, dto: CreatePostDto) {
    // Cek slug unik
    const exist = await this.prisma.blogPost.findUnique({ where: { slug: dto.slug } });
    if (exist) throw new BadRequestException('Slug artikel sudah dipakai.');

    return this.prisma.blogPost.create({
      data: {
        title: dto.title,
        slug: dto.slug,
        contentHtml: dto.contentHtml,
        thumbnailUrl: dto.thumbnailUrl,
        categoryId: BigInt(dto.categoryId),
        authorId: BigInt(authorId),
        status: dto.status || 'draft',
        publishedAt: dto.status === 'published' ? new Date() : null,

        // SEO
        metaTitle: dto.metaTitle,
        metaDescription: dto.metaDescription,
        metaKeywords: dto.metaKeywords,
      }
    });
  }

  // ============================
  // 🌍 PUBLIC API (Frontend)
  // ============================

  // 1. List Artikel (Pagination + Filter)
  async findAllPublished(page = 1, limit = 6, categorySlug?: string) {
    const skip = (page - 1) * limit;

    const whereClause: any = { status: 'published' };

    // Filter by Category Slug jika ada
    if (categorySlug) {
      const cat = await this.prisma.blogCategory.findUnique({ where: { slug: categorySlug } });
      if (cat) whereClause.categoryId = cat.id;
    }

    const [posts, total] = await this.prisma.$transaction([
      this.prisma.blogPost.findMany({
        where: whereClause,
        skip,
        take: limit,
        orderBy: { publishedAt: 'desc' },
        include: {
          category: true,
          author: { select: { name: true } }
        }
      }),
      this.prisma.blogPost.count({ where: whereClause })
    ]);

    return {
      data: posts.map(p => ({
        ...p,
        id: p.id.toString(),
        categoryId: p.categoryId.toString(),
        authorId: p.authorId.toString(),
      })),
      meta: { total, page, lastPage: Math.ceil(total / limit) }
    };
  }

  // 2. Baca Detail Artikel (Slug)
  async findBySlug(slug: string) {
    const post = await this.prisma.blogPost.findUnique({
      where: { slug },
      include: {
        category: true,
        author: { select: { name: true } }
      }
    });

    if (!post || post.status !== 'published') throw new NotFoundException('Artikel tidak ditemukan.');

    return {
      ...post,
      id: post.id.toString(),
      categoryId: post.categoryId.toString(),
      authorId: post.authorId.toString(),
    };
  }
}