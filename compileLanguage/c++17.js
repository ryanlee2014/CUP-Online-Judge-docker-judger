module.exports = {
    compile_method(name, fn, ...options){
        return require("./c++").compile_method(name, fn, 17, ...options);
    },
    init(submit){
        require("./c++").init(submit);
    }
};