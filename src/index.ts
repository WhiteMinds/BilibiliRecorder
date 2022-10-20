import path from 'path'
import mitt from 'mitt'
import {
  Recorder,
  RecorderCreateOpts,
  RecorderProvider,
  createFFMPEGBuilder,
  RecordHandle,
  defaultFromJSON,
  defaultToJSON,
  genRecorderUUID,
  genRecordUUID,
  createRecordExtraDataController,
  Comment,
  GiveGift,
} from '@autorecord/manager'
import { getInfo, getStream } from './stream'
import { ensureFolderExist, singleton } from './utils'
// TODO: 这个包类型有点问题，现在先手改下 d.ts 再编译，等修复
// https://github.com/ddiu8081/blive-message-listener/issues/11
import { startListen, MsgHandler } from 'blive-message-listener'

function createRecorder(opts: RecorderCreateOpts): Recorder {
  const checkLiveStatusAndRecord = singleton<
    Recorder['checkLiveStatusAndRecord']
  >(async function ({ getSavePath }) {
    if (this.recordHandle != null) return this.recordHandle

    const { living, owner, title } = await getInfo(this.channelId)
    if (!living) return null

    this.state = 'recording'
    const {
      currentStream: stream,
      sources: availableSources,
      streams: availableStreams,
    } = await getStream({
      channelId: opts.channelId,
      quality: opts.quality,
      streamPriorities: opts.streamPriorities,
      sourcePriorities: opts.sourcePriorities,
    })
    this.availableStreams = availableStreams.map((s) => s.desc)
    this.availableSources = availableSources.map((s) => s.name)
    this.usedStream = stream.name
    this.usedSource = stream.source
    // TODO: emit update event

    const savePath = getSavePath({ owner, title })

    // TODO: 之后可能要结合 disableRecordMeta 之类的来确认是否要创建文件。
    const extraDataSavePath = savePath + '.json'
    // TODO: 这个 ensure 或许应该放在 createRecordExtraDataController 里实现？
    ensureFolderExist(extraDataSavePath)
    const extraDataController =
      createRecordExtraDataController(extraDataSavePath)

    extraDataController.setMeta({ title })

    let client: ReturnType<typeof startListen> | null = null
    if (!this.disableProvideCommentsWhenRecording) {
      const handler: MsgHandler = {
        onIncomeDanmu: (msg) => {
          const comment: Comment = {
            type: 'comment',
            timestamp: msg.timestamp,
            text: msg.body.content,
            sender: {
              uid: String(msg.body.user.uid),
              name: msg.body.user.uname,
              avatar: msg.body.user.face,
              extra: {
                badgeName: msg.body.user.badge?.name,
                badgeLevel: msg.body.user.badge?.level,
              },
            },
          }
          this.emit('Message', comment)
          extraDataController.addMessage(comment)
        },
        onIncomeSuperChat: (msg) => {
          console.log(msg.id, msg.body)
        },
        onGift: (msg) => {
          const gift: GiveGift = {
            type: 'give_gift',
            timestamp: msg.timestamp,
            name: msg.body.gift_name,
            count: msg.body.amount,
            sender: {
              uid: String(msg.body.user.uid),
              name: msg.body.user.uname,
              avatar: msg.body.user.face,
              extra: {
                badgeName: msg.body.user.badge?.name,
                badgeLevel: msg.body.user.badge?.level,
              },
            },
            extra: {
              hits: msg.body.combo?.combo_num,
            },
          }
          this.emit('Message', gift)
          extraDataController.addMessage(gift)
        },
      }

      client = startListen(Number(this.channelId), handler)
    }

    const recordSavePath = savePath + '.flv'
    ensureFolderExist(recordSavePath)

    const callback = (...args: unknown[]) => {
      console.log('cb', ...args)
    }
    // TODO: 主播重新开关播后原来的直播流地址会失效，这可能会导致录制出现问题，需要处理。
    const command = createFFMPEGBuilder(stream.url)
      .outputOptions(
        '-user_agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/73.0.3683.86 Safari/537.36',
        '-c',
        'copy',
        '-flvflags',
        'add_keyframe_index'
      )
      .output(recordSavePath)
      .on('error', callback)
      .on('end', () => callback())
      .on('stderr', (stderrLine) => {
        console.error(`FFMPEG [${this.channelId}]:`, stderrLine)

        // if (stderrLine.startsWith('frame=')) {
        //   if (waitFirstFrame) {
        //     waitFirstFrame = false
        //     // 发出通知
        //     if (config.record.notice && !isSwitching)
        //       createNotice(channel.profile, channelInfo.title)
        //   }

        //   // TODO: 在此处对长时间无frame时的情况做检查。
        // }
      })
    command.run()
    extraDataController.setMeta({ recordStartTimestamp: Date.now() })

    const stop = singleton<RecordHandle['stop']>(async () => {
      if (!this.recordHandle) return
      this.state = 'stopping-record'
      // TODO: emit update event

      // 如果给 SIGKILL 信号会非正常退出，那么录制结束时应该应用的 add_keyframe_index 就会被跳过。
      // TODO: fluent-ffmpeg 好像没处理好这个 SIGINT 导致的退出信息，会抛一个错。
      command.kill('SIGINT')
      // TODO: 这里可能会有内存泄露，因为事件还没清，之后再检查下看看。
      client?.close()
      extraDataController.flush()

      this.usedStream = undefined
      this.usedSource = undefined
      // TODO: other codes
      // TODO: emit update event

      this.emit('RecordStop', this.recordHandle)
      this.recordHandle = undefined
      this.state = 'idle'
    })

    this.recordHandle = {
      id: genRecordUUID(),
      stream: stream.name,
      source: stream.source,
      url: stream.url,
      savePath: recordSavePath,
      stop,
    }
    this.emit('RecordStart', this.recordHandle)

    return this.recordHandle
  })

  const recorder: Recorder = {
    id: opts.id ?? genRecorderUUID(),
    ...mitt(),
    ...opts,

    availableStreams: [],
    availableSources: [],
    state: 'idle',

    getChannelURL() {
      return `https://live.bilibili.com/${this.channelId}`
    },
    checkLiveStatusAndRecord,

    toJSON() {
      return defaultToJSON(provider, this)
    },
  }

  return recorder
}

export const provider: RecorderProvider = {
  id: 'Bilibili',
  name: 'Bilibili',
  siteURL: 'https://live.bilibili.com/',

  matchURL(channelURL) {
    return /https?:\/\/(?:.*?\.)?bilibili.com\//.test(channelURL)
  },

  async resolveChannelInfoFromURL(channelURL) {
    if (!this.matchURL(channelURL)) return null

    const id = path.basename(new URL(channelURL).pathname)
    const info = await getInfo(id)

    return {
      id,
      title: info.title,
      owner: info.owner,
    }
  },

  createRecorder(opts) {
    return createRecorder({ providerId: provider.id, ...opts })
  },

  fromJSON(recorder) {
    return defaultFromJSON(this, recorder)
  },
}
