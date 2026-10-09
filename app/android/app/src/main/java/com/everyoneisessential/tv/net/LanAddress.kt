package com.everyoneisessential.tv.net

import java.net.Inet4Address
import java.net.NetworkInterface
import java.util.Collections

/**
 * The Stick's own LAN address, so the QR code the TV shows points at itself
 * and not at whatever machine happened to build the app.
 *
 * `NetworkInterface` needs no permission beyond INTERNET/ACCESS_NETWORK_STATE
 * and answers the same way over Wi-Fi or wired Ethernet, so it is used
 * directly rather than `WifiManager`, which only knows about Wi-Fi and, on
 * newer Android, needs a location permission to return a real address --
 * moot on API 25 but no reason to add the dependency for it.
 */
object LanAddress {
    /** The first non-loopback, non-link-local IPv4 address on an interface that is up, or null. */
    fun find(): String? = try {
        Collections.list(NetworkInterface.getNetworkInterfaces())
            .filter { it.isUp && !it.isLoopback && !it.isVirtual }
            .flatMap { Collections.list(it.inetAddresses) }
            .filterIsInstance<Inet4Address>()
            .firstOrNull { !it.isLoopbackAddress && !it.isLinkLocalAddress }
            ?.hostAddress
    } catch (e: Exception) {
        null
    }
}
