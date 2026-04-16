

let map = fn(arr, f) {
  let result = []
  let i = 0
  while (i < len(arr)) {
    set result = push(result, f(arr[i]))
    set i = i + 1
  }
  return result
}

let filter = fn(arr, pred) {
  let result = []
  let i = 0
  while (i < len(arr)) {
    if (pred(arr[i])) {
      set result = push(result, arr[i])
    }
    set i = i + 1
  }
  return result
}

let reduce = fn(arr, init, f) {
  let acc = init
  let i = 0
  while (i < len(arr)) {
    set acc = f(acc, arr[i])
    set i = i + 1
  }
  return acc
}

let foreach = fn(arr, f) {
  let i = 0
  while (i < len(arr)) {
    f(arr[i])
    set i = i + 1
  }
}


let compose = fn(f, g, x) { f(g(x)) }

let apply = fn(f, x) { f(x) }

let twice = fn(f, x) { f(f(x)) }

let apply_n = fn(f, n, x) {
  let result = x
  let i = 0
  while (i < n) {
    set result = f(result)
    set i = i + 1
  }
  return result
}


let abs = fn(x) { if (x < 0) { return 0 - x }; return x }

let max = fn(a, b) { if (a > b) { return a }; return b }

let min = fn(a, b) { if (a < b) { return a }; return b }

let gcd = fn(a, b) { if (b == 0) { return a }; return gcd(b, a % b) }

let power = fn(base, exp) {
  if (exp == 0) { return 1 }
  return base * power(base, exp - 1)
}

let is_prime = fn(n) {
  if (n < 2) { return 0 }
  let i = 2
  while (i * i <= n) {
    if (n % i == 0) { return 0 }
    set i = i + 1
  }
  return 1
}


let range = fn(start, stop) {
  let result = []
  let i = start
  while (i < stop) {
    set result = push(result, i)
    set i = i + 1
  }
  return result
}

let _add = fn(a, b) { a + b }
let _mul = fn(a, b) { a * b }

let sum = fn(arr) { reduce(arr, 0, _add) }

let product = fn(arr) { reduce(arr, 1, _mul) }

let arr_max = fn(arr) {
  let m = arr[0]
  let i = 1
  while (i < len(arr)) {
    if (arr[i] > m) { set m = arr[i] }
    set i = i + 1
  }
  return m
}

let arr_min = fn(arr) {
  let m = arr[0]
  let i = 1
  while (i < len(arr)) {
    if (arr[i] < m) { set m = arr[i] }
    set i = i + 1
  }
  return m
}

let contains = fn(arr, val) {
  let i = 0
  while (i < len(arr)) {
    if (arr[i] == val) { return 1 }
    set i = i + 1
  }
  return 0
}

let count_if = fn(arr, pred) {
  let c = 0
  let i = 0
  while (i < len(arr)) {
    if (pred(arr[i])) { set c = c + 1 }
    set i = i + 1
  }
  return c
}


let cons = fn(head, tail) { [head, tail] }
let car = fn(pair) { pair[0] }
let cdr = fn(pair) { pair[1] }
let is_nil = fn(pair) { len(pair) == 0 }

let list_len = fn(lst) {
  let n = 0
  while (len(lst) > 0) {
    set n = n + 1
    set lst = cdr(lst)
  }
  return n
}


let make_adder = fn(n) { fn(x) { x + n } }
let make_multiplier = fn(n) { fn(x) { x * n } }
let make_checker = fn(threshold) { fn(x) { x > threshold } }

let reverse = fn(arr) {
  let result = []
  let i = len(arr) - 1
  while (i >= 0) {
    set result = push(result, arr[i])
    set i = i - 1
  }
  return result
}

let zip_with = fn(arr1, arr2, f) {
  let result = []
  let i = 0
  let n = min(len(arr1), len(arr2))
  while (i < n) {
    set result = push(result, f(arr1[i], arr2[i]))
    set i = i + 1
  }
  return result
}

let any = fn(arr, pred) {
  let i = 0
  while (i < len(arr)) {
    if (pred(arr[i])) { return 1 }
    set i = i + 1
  }
  return 0
}

let all = fn(arr, pred) {
  let i = 0
  while (i < len(arr)) {
    if (!pred(arr[i])) { return 0 }
    set i = i + 1
  }
  return 1
}
