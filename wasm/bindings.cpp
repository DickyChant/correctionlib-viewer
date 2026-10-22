// Browser bindings for correctionlib's C++ evaluator.
//
// The page parses a correctionlib JSON document with CorrectionSet::from_string
// and evaluates through the same code as correctionlib's Python and C++
// interfaces, so the numbers it shows are the ones an analysis gets.
//
// Errors never cross into JavaScript as exceptions: load() returns the message,
// evaluate() returns {error}, and the scans return NaN where an evaluation
// failed, together with the first message.
#include <cmath>
#include <cstdint>
#include <functional>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

#include <emscripten/bind.h>
#include <emscripten/val.h>

#include "correction.h"

using correction::Variable;
using emscripten::val;

namespace {

// A correction or a compound correction: its inputs and its evaluate().
struct Target {
  const std::vector<Variable>* inputs = nullptr;
  std::function<double(const std::vector<Variable::Type>&)> evaluate;
};

// One value per input, from a JavaScript array of numbers and strings. Integer
// inputs are rounded to the nearest integer.
std::vector<Variable::Type> convert(const std::vector<Variable>& variables,
                                    const val& inputs) {
  const auto n = inputs["length"].as<std::size_t>();
  if (n != variables.size()) {
    throw std::runtime_error("expected " + std::to_string(variables.size()) +
                             " inputs, got " + std::to_string(n));
  }
  std::vector<Variable::Type> values;
  values.reserve(n);
  for (std::size_t i = 0; i < n; ++i) {
    const val v = inputs[i];
    const bool isString = v.typeOf().as<std::string>() == "string";
    switch (variables[i].type()) {
      case Variable::VarType::string:
        if (!isString) {
          throw std::runtime_error("input '" + variables[i].name() +
                                   "' must be a string");
        }
        values.emplace_back(v.as<std::string>());
        break;
      case Variable::VarType::integer:
        if (isString) {
          throw std::runtime_error("input '" + variables[i].name() +
                                   "' must be a number");
        }
        values.emplace_back(static_cast<int64_t>(std::llround(v.as<double>())));
        break;
      case Variable::VarType::real:
        if (isString) {
          throw std::runtime_error("input '" + variables[i].name() +
                                   "' must be a number");
        }
        values.emplace_back(v.as<double>());
        break;
    }
  }
  return values;
}

// Sets input `index` to x, keeping its type.
void assign(std::vector<Variable::Type>& values,
            const std::vector<Variable>& variables, int index, double x) {
  if (variables.at(index).type() == Variable::VarType::integer) {
    values[index] = static_cast<int64_t>(std::llround(x));
  } else if (variables[index].type() == Variable::VarType::real) {
    values[index] = x;
  } else {
    throw std::runtime_error("input '" + variables[index].name() +
                             "' is a string and cannot be scanned");
  }
}

val toFloat64Array(const std::vector<double>& v) {
  // The memory view is copied by the Float64Array constructor, so the result
  // stays valid after v goes away.
  return val::global("Float64Array")
      .new_(emscripten::typed_memory_view(v.size(), v.data()));
}

std::vector<double> toVector(const val& array) {
  const auto n = array["length"].as<std::size_t>();
  std::vector<double> v(n);
  for (std::size_t i = 0; i < n; ++i) v[i] = array[i].as<double>();
  return v;
}

class Evaluator {
 public:
  // Parses a correctionlib JSON document (not gzipped). Returns "" on success,
  // otherwise the error message; the previously loaded set is dropped either
  // way.
  std::string load(const std::string& json) {
    set_.reset();
    try {
      set_ = correction::CorrectionSet::from_string(json.c_str());
    } catch (const std::exception& e) {
      return e.what();
    }
    return "";
  }

  // {value: number} or {error: string}. `inputs` holds one value per input of
  // the correction, in its order.
  val evaluate(const std::string& name, const val& inputs) const {
    val out = val::object();
    try {
      const Target t = target(name);
      out.set("value", t.evaluate(convert(*t.inputs, inputs)));
    } catch (const std::exception& e) {
      out.set("error", std::string(e.what()));
    }
    return out;
  }

  // The correction with input `index` set to each of `xs` in turn and the
  // others as in `inputs`: {values: Float64Array, error?: string}.
  val scan(const std::string& name, const val& inputs, int index,
           const val& xs) const {
    return scan2d(name, inputs, index, xs, -1, val::array());
  }

  // As scan(), over the grid xs × ys of inputs `ix` and `iy`. values[j * nx + i]
  // belongs to (xs[i], ys[j]). With iy = -1 this is a scan in x alone.
  val scan2d(const std::string& name, const val& inputs, int ix, const val& xs,
             int iy, const val& ys) const {
    val out = val::object();
    std::vector<double> values;
    std::string error;
    try {
      const Target t = target(name);
      auto point = convert(*t.inputs, inputs);
      const auto gx = toVector(xs);
      const auto gy = iy < 0 ? std::vector<double>{0.} : toVector(ys);
      values.assign(gx.size() * gy.size(),
                    std::numeric_limits<double>::quiet_NaN());
      for (std::size_t j = 0; j < gy.size(); ++j) {
        if (iy >= 0) assign(point, *t.inputs, iy, gy[j]);
        for (std::size_t i = 0; i < gx.size(); ++i) {
          assign(point, *t.inputs, ix, gx[i]);
          try {
            values[j * gx.size() + i] = t.evaluate(point);
          } catch (const std::exception& e) {
            if (error.empty()) error = e.what();
          }
        }
      }
    } catch (const std::exception& e) {
      error = e.what();
    }
    out.set("values", toFloat64Array(values));
    if (!error.empty()) out.set("error", error);
    return out;
  }

 private:
  Target target(const std::string& name) const {
    if (!set_) throw std::runtime_error("no correction set loaded");
    for (const auto& [key, correction] : *set_) {
      if (key == name) {
        return {&correction->inputs(),
                [c = correction](const std::vector<Variable::Type>& v) {
                  return c->evaluate(v);
                }};
      }
    }
    const auto& compound = set_->compound();
    const auto it = compound.find(name);
    if (it == compound.end()) {
      throw std::runtime_error("no correction named '" + name + "'");
    }
    return {&it->second->inputs(),
            [c = it->second](const std::vector<Variable::Type>& v) {
              return c->evaluate(v);
            }};
  }

  std::unique_ptr<correction::CorrectionSet> set_;
};

}  // namespace

EMSCRIPTEN_BINDINGS(correctionlib) {
  emscripten::class_<Evaluator>("Evaluator")
      .constructor<>()
      .function("load", &Evaluator::load)
      .function("evaluate", &Evaluator::evaluate)
      .function("scan", &Evaluator::scan)
      .function("scan2d", &Evaluator::scan2d);
  emscripten::constant("correctionlibVersion",
                       std::string(correction::correctionlib_version));
}
