import { Module } from '@nestjs/common';
import { NumberSequenceService } from './numbering.service.js';

@Module({
  providers: [NumberSequenceService],
  exports: [NumberSequenceService],
})
export class NumberingModule {}
