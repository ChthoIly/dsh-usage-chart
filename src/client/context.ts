/**
 * 浏览器端 DSH Client Context 的最小声明（自包含，不依赖退役的
 * `@deepseek-ai/dsh-client-runtime`，也不引用未随插件发布的 vendored 类型）。
 *
 * DSH 0.1.x 与 0.2.x 的客户端插件都运行在 cordis Context 上；本插件只使用
 * `slots`（槽位注册）与 `locale`（活动语言订阅）两个服务，它们在
 * 0.1.0-rc.6 – 0.2.1-rc.2 间保持同一形状：
 *  - 0.1.x：由 dsh-client-runtime / dsh-client-ui-slots 提供；
 *  - 0.2.x：dsh-client-runtime 退役，服务改由 dsh-client-ui-renderer 的
 *    SlotRegistry 与 dsh-client-locale 提供，注册/订阅接口不变。
 * 这里声明的是插件实际用到的子集；真实类型以运行时 DSH 为准。
 */

/** ui-slots 槽位注册选项（list 槽需要 id；order 控制同槽内顺序）。 */
export interface ClientSlotRegisterOptions {
  name: string
  id?: string
  order?: number
  priority?: number
  /** 诊断用途的注册者标签（0.1.x / 0.2.x 均接受）。 */
  registrant?: string
  locale?: string
}

/** ui-slots 的 SlotRegistry 服务（register / inject 均返回卸载函数）。 */
export interface ClientSlotRegistry {
  register(options: ClientSlotRegisterOptions, component: unknown): () => void
  /** 等待某个槽位声明出现后注册（声明生命周期内生效，随调用方 fiber 卸载）。 */
  inject(key: string, callback: () => (() => void) | void): () => void
}

/** dsh-client-locale 的 locale 服务（仅活动语言订阅面）。 */
export interface ClientLocaleService {
  /** 当前语言快照（active = 'zh' | 'en'；语言切换或字典注册都会通知订阅者）。 */
  getLocale(): { active: string; locales: readonly { id: string }[]; revision: number }
  /** 订阅快照变化（监听器无参调用，自行重读 getLocale；返回退订函数）。 */
  subscribe(listener: () => void): () => void
}

/** 浏览器端 cordis Context（本插件客户端半区用到的面）。 */
export interface ClientContext {
  /** 注册一个资源释放器，插件卸载时执行。 */
  effect(disposer: () => (() => void) | void, label?: string): void
  slots: ClientSlotRegistry
  locale: ClientLocaleService
}
