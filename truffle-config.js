module.exports = {
  // Documentation: http://truffleframework.com/docs/advanced/configuration

  networks: {
    development: {
      host: "127.0.0.1",     // Local Ganache endpoint
      port: 7545,            // Ganache GUI default port
      network_id: "*" // To match any network id
    }
  },
  compilers: {
    solc: {
      version: "0.5.16"  
    }
  }
};
