import { PartialType } from '@nestjs/mapped-types';
import { CreatePostDto } from './create-blog.dto';

export class UpdateBlogDto extends PartialType(CreatePostDto) { }
