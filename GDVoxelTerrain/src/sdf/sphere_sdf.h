#ifndef SPHERE_SDF_H
#define SPHERE_SDF_H

#include "signed_distance_field.h"

class JarSphereSdf : public JarSignedDistanceField
{
    GDCLASS(JarSphereSdf, JarSignedDistanceField);

  private:
    glm::vec3 _center;
    float _radius;

  public:
    JarSphereSdf() : _center(0.0f, 0.0f, 0.0f), _radius(1.0f)
    {
    }
    void set_center(const Vector3 &center)
    {
        _center = glm::vec3(center.x, center.y, center.z);
    }
    Vector3 get_center() const
    {
        return Vector3(_center.x, _center.y, _center.z);
    }
    void set_radius(float radius)
    {
        _radius = radius;
    }
    float get_radius() const
    {
        return _radius;
    }

    virtual float distance(const glm::vec3 &pos) const override
    {
        return glm::length(pos - _center) - _radius;
    }

  protected:
    static void _bind_methods()
    {
        ClassDB::bind_method(D_METHOD("set_center", "center"), &JarSphereSdf::set_center);
        ClassDB::bind_method(D_METHOD("get_center"), &JarSphereSdf::get_center);
        ClassDB::bind_method(D_METHOD("set_radius", "radius"), &JarSphereSdf::set_radius);
        ClassDB::bind_method(D_METHOD("get_radius"), &JarSphereSdf::get_radius);
        ADD_PROPERTY(PropertyInfo(Variant::VECTOR3, "center"), "set_center", "get_center");
        ADD_PROPERTY(PropertyInfo(Variant::FLOAT, "radius"), "set_radius", "get_radius");
    }
};

#endif // SPHERE_SDF_H
