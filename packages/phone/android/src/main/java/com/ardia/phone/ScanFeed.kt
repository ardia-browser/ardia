package com.ardia.phone

import com.ardia.settings.QrDecoder
import com.ardia.sync.core.RecoveryPhrase
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel

object ScanFeed {
    private const val SIDE = 480

    fun throwawayPhrase(): String = RecoveryPhrase.words(RecoveryPhrase.generateEntropy()).joinToString(" ")

    fun luminance(text: String): ByteArray {
        val matrix = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, SIDE, SIDE, mapOf(EncodeHintType.MARGIN to 4, EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M))
        return ByteArray(SIDE * SIDE) { index -> if (matrix[index % SIDE, index / SIDE]) 0 else 0xFF.toByte() }
    }

    fun decodeAsCamera(text: String): String? = QrDecoder().decode(luminance(text), SIDE, SIDE, SIDE)
}
