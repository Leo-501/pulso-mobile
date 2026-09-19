const { getDefaultConfig } = require('expo/metro-config');

// O contrato chega como pacote compilado (@pulso/contracts), com dist/ e exports.
// O resolvedor customizado que existia aqui só era necessário enquanto o Metro
// empacotava o TypeScript cru de packages/ com imports NodeNext terminados em .js.
module.exports = getDefaultConfig(__dirname);
