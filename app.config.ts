export default {
  expo: {
    name: 'Pulso Manutenção',
    slug: 'pulso-cmms',
    version: '0.2.0',
    orientation: 'portrait',
    userInterfaceStyle: 'light',
    platforms: ['android'],
    android: {
      package: 'com.pulso.cmms',
      allowBackup: false,
      blockedPermissions: [
        'android.permission.RECORD_AUDIO',
        'android.permission.READ_EXTERNAL_STORAGE',
        'android.permission.WRITE_EXTERNAL_STORAGE',
      ],
    },
    plugins: [
      [
        'expo-build-properties',
        { android: { usesCleartextTraffic: process.env.PULSO_ALLOW_LOCAL_HTTP === '1' } },
      ],
      ['expo-sqlite', { useSQLCipher: true }],
      ['expo-secure-store', { configureAndroidBackup: true }],
      [
        'expo-camera',
        {
          cameraPermission: 'Permita a câmera para ler o QR Code das máquinas.',
          recordAudioAndroid: false,
          barcodeScannerEnabled: true,
        },
      ],
    ],
  },
};
