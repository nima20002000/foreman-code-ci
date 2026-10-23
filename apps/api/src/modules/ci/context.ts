// Main's CI context: the platform and the server ports, built once. Every CI class and function Main composes gets it.
import { createCiContext, type MainCiContext } from '@foreman-code/ci/environment'
import { ciPlatform } from './platform.js'
import { ciServerPorts } from './serverPorts.js'

export const mainCiContext: MainCiContext = createCiContext(ciPlatform, ciServerPorts)
