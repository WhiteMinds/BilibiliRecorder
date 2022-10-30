// execute in shell `ts-node src/test.ts` to run test
// TODO: add to scripts
import { createRecorderManager } from '@autorecord/manager'
import { provider } from '.'

const manager = createRecorderManager({ providers: [provider] })
manager.addRecorder({
  providerId: provider.id,
  channelId: '7734200',
  quality: 'low',
  streamPriorities: [],
  sourcePriorities: [],
})
manager.startCheckLoop()
