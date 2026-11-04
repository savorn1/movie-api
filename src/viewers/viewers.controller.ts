import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ViewersService } from './viewers.service';
import {
  ChangePasswordDto,
  IdentityDto,
  LibraryDto,
  LoginDto,
  RegisterDto,
} from './viewers.dto';

/**
 * Viewer accounts for RuengFlix's server, which keeps the session and only asks for the signed-in
 * viewer's own id. Like every route here, it needs MOVIE_API_TOKEN.
 */
@Controller('viewers')
export class ViewersController {
  constructor(private readonly viewers: ViewersService) {}

  @Post()
  register(@Body() body: RegisterDto) {
    return this.viewers.register(body);
  }

  @Post('login')
  @HttpCode(200)
  login(@Body() body: LoginDto) {
    return this.viewers.login(body);
  }

  @Post('identity')
  @HttpCode(200)
  identity(@Body() body: IdentityDto) {
    return this.viewers.identity(body);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number) {
    return this.viewers.get(id);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.viewers.remove(id);
  }

  @Put(':id/password')
  changePassword(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: ChangePasswordDto,
  ) {
    return this.viewers.changePassword(id, body);
  }

  @Get(':id/library')
  library(@Param('id', ParseIntPipe) id: number) {
    return this.viewers.library(id);
  }

  @Put(':id/library')
  saveLibrary(@Param('id', ParseIntPipe) id: number, @Body() body: LibraryDto) {
    return this.viewers.saveLibrary(id, body.data);
  }
}
