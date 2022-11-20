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
import { startListen, MsgHandler } from 'blive-message-listener'

function createRecorder(opts: RecorderCreateOpts): Recorder {
  // 内部实现时，应该只有 proxy 包裹的那一层会使用这个 recorder 标识符，不应该有直接通过
  // 此标志来操作这个对象的地方，不然会跳过 proxy 的拦截。
  const recorder: Recorder = {
    id: opts.id ?? genRecorderUUID(),
    extra: opts.extra ?? {},
    ...mitt(),
    ...opts,

    availableStreams: [],
    availableSources: [],
    state: 'idle',

    getChannelURL() {
      return `https://live.bilibili.com/${this.channelId}`
    },
    checkLiveStatusAndRecord: singleton(checkLiveStatusAndRecord),

    toJSON() {
      return defaultToJSON(provider, this)
    },
  }

  const recorderWithSupportUpdatedEvent = new Proxy(recorder, {
    set(obj, prop, value) {
      Reflect.set(obj, prop, value)

      if (typeof prop === 'string') {
        obj.emit('Updated', [prop])
      }

      return true
    },
  })

  return recorderWithSupportUpdatedEvent
}

const checkLiveStatusAndRecord: Recorder['checkLiveStatusAndRecord'] =
  async function ({ getSavePath }) {
    if (this.recordHandle != null) return this.recordHandle

    const { living, owner, title } = await getInfo(this.channelId)
    if (!living) return null

    this.state = 'recording'
    const {
      currentStream: stream,
      sources: availableSources,
      streams: availableStreams,
    } = await getStream({
      channelId: this.channelId,
      quality: this.quality,
      streamPriorities: this.streamPriorities,
      sourcePriorities: this.sourcePriorities,
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

    const recordSavePath = savePath + '.mp4'
    ensureFolderExist(recordSavePath)

    const callback = (...args: unknown[]) => {
      console.log('cb', ...args)
    }
    // TODO: 主播重新开关播后原来的直播流地址会失效，这可能会导致录制出现问题，需要处理。
    /**
     * FragmentMP4 可以边录边播（浏览器原生支持），具有一定的抗损坏能力，录制中 KILL 只会
     * 丢失最后一个片段，而 FLV 格式如果录制中 KILL 了需要手动修复下 keyframes。
     */
    const command = createFFMPEGBuilder(stream.url)
      .outputOptions(
        '-user_agent',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/73.0.3683.86 Safari/537.36',
        '-c',
        'copy',
        '-f',
        'mp4',
        '-movflags',
        'frag_keyframe',
        /**
         * 浏览器加载 FragmentMP4 会需要先把它所有的 moof boxes 都加载完成后才能播放，
         * 默认的分段时长很小，会产生大量的 moof，导致加载很慢，所以这里设置一个分段的最小时长。
         *
         * TODO: 这个浏览器行为或许是可以优化的，比如试试给 fmp4 在录制完成后设置或者录制过程中实时更新 mvhd.duration。
         * https://stackoverflow.com/questions/55887980/how-to-use-media-source-extension-mse-low-latency-mode
         * https://stackoverflow.com/questions/61803136/ffmpeg-fragmented-mp4-takes-long-time-to-start-playing-on-chrome
         *
         * TODO: 如果浏览器行为无法优化，并且想进一步优化加载速度，可以考虑录制时使用 fmp4，录制完成后再转一次普通 mp4。
         */
        '-min_frag_duration',
        '60000000'
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

    // TODO: 需要一个机制防止空录制，比如检查文件的大小变化、ffmpeg 的输出、直播状态等

    const stop = singleton<RecordHandle['stop']>(async () => {
      if (!this.recordHandle) return
      this.state = 'stopping-record'
      // TODO: emit update event

      // 如果给 SIGKILL 信号会非正常退出，SIGINT 可以被 ffmpeg 正常处理。
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
  }

export const provider: RecorderProvider<{}> = {
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
