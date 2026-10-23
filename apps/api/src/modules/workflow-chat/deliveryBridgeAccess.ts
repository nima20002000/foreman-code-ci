import type { ChatDeliveryBridge } from './deliveryBridge.js'

const bridges = new WeakMap<object, ChatDeliveryBridge>()
export function installChatDeliveryBridge(service: object, bridge: ChatDeliveryBridge): void {
  if (bridges.has(service)) throw new Error('The common chat delivery bridge is already installed.')
  bridges.set(service, bridge)
}
/** OperatorServices uses a narrow service Pick; this accessor preserves that existing composition type. */
export function operatorDeliveryBridge(service: object): ChatDeliveryBridge | undefined { return bridges.get(service) }
