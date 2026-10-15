// In JavaScript `any` is just a name: none of these are type annotations.
const any = 1;
const options = { key: any, other: true ? 2 : any };
module.exports = { options };
