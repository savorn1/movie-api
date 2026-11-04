import { Global, Module } from '@nestjs/common';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { APP_CONFIG, type AppConfig } from '../config';
import { MediaUrls } from './media-urls';

@Global()
@Module({
  providers: [
    {
      provide: MediaUrls,
      inject: [APP_CONFIG],
      useFactory: ({ media }: AppConfig) => {
        // Signed against the public endpoint, as VideoLingo does, so browsers can reach the link
        const s3 = new S3Client({
          region: media.region,
          endpoint: media.publicEndpoint || undefined,
          forcePathStyle: true,
          credentials: media.accessKeyId
            ? {
                accessKeyId: media.accessKeyId,
                secretAccessKey: media.secretAccessKey,
              }
            : undefined,
        });
        return new MediaUrls({
          publicEndpoint: media.publicEndpoint,
          bucket: media.bucket,
          enabled: media.signedUrls,
          ttlSeconds: media.ttlMinutes * 60,
          presign: (key, ttlSeconds) =>
            getSignedUrl(
              s3,
              new GetObjectCommand({ Bucket: media.bucket, Key: key }),
              { expiresIn: ttlSeconds },
            ),
        });
      },
    },
  ],
  exports: [MediaUrls],
})
export class MediaModule {}
