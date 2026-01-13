#ifndef SDF_OPERATIONS_H
#define SDF_OPERATIONS_H

#include <algorithm>
#include <glm/glm.hpp>

namespace SDF
{
enum Operation
{
    SDF_OPERATION_UNION,
    SDF_OPERATION_SUBTRACTION,
    SDF_OPERATION_INTERSECTION,
    SDF_OPERATION_SMOOTH_UNION,
    SDF_OPERATION_SMOOTH_SUBTRACTION,
    SDF_OPERATION_SMOOTH_INTERSECTION,
};

static inline float apply_operation(Operation op, float a, float b, float k = 1.0f)
{
    switch (op)
    {
    case SDF_OPERATION_UNION:
        return std::min(a, b);
    case SDF_OPERATION_SUBTRACTION:
        return std::max(a, -b);
    case SDF_OPERATION_INTERSECTION:
        return std::max(a, b);
    case SDF_OPERATION_SMOOTH_UNION:
    {
        float h = std::clamp(0.5f + 0.5f * (b - a) / k, 0.0f, 1.0f);
        return glm::mix(b, a, h) - k * h * (1.0f - h);
    }
    case SDF_OPERATION_SMOOTH_SUBTRACTION:
    {
        float h = std::clamp(0.5f - 0.5f * (b + a) / k, 0.0f, 1.0f);
        return glm::mix(a, -b, h) + k * h * (1.0f - h);
    }
    case SDF_OPERATION_SMOOTH_INTERSECTION:
    {
        float h = std::clamp(0.5f - 0.5f * (b - a) / k, 0.0f, 1.0f);
        return glm::mix(b, a, h) + k * h * (1.0f - h);
    }
    default:
        return a;
    }
}
} // namespace SDF

#endif // SDF_OPERATIONS_H